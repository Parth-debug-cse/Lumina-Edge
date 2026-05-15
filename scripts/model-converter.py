#!/usr/bin/env python3
# ==============================================================================
# Lumina Edge :: Model Converter — Cross-Platform LLM Format Converter
# Platform backends:
#   - Windows/Linux: llama.cpp (convert_hf_to_gguf.py + llama-quantize)
#   - macOS: mlx-lm (MLX backend, loads safetensors directly + quantization)
# ==============================================================================

import sys
import json
import os
import subprocess
import shutil
import struct
import tempfile
from pathlib import Path
from typing import Optional, Tuple, Dict, Any, Callable
import argparse
import logging
import platform

# Try to import shard-loader module
try:
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "shard_loader",
        Path(__file__).parent / "shard-loader.py"
    )
    shard_loader_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(shard_loader_module)
    SHARD_LOADER_AVAILABLE = True
    ShardedModelInfo = shard_loader_module.ShardedModelInfo
    ShardedModelConverter = shard_loader_module.ShardedModelConverter
except Exception:
    SHARD_LOADER_AVAILABLE = False
    ShardedModelInfo = None
    ShardedModelConverter = None

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


# ==============================================================================
# Progress Reporting (fixed shadowing bug with class-based approach)
# ==============================================================================

class ProgressReporter:
    """Callable progress reporter that avoids naming conflicts."""
    
    def __init__(self, enabled: bool = True):
        self.enabled = enabled
        self.current = 0
    
    def __call__(self, percent: int):
        """Report progress percentage."""
        if self.enabled:
            self.current = max(0, min(100, percent))
            print(f"PROGRESS: {self.current}%", flush=True)
    
    def step(self, message: str, percent: int):
        """Log a step and update progress."""
        logger.info(message)
        self(percent)


# ==============================================================================
# Platform Detection
# ==============================================================================

def get_platform() -> str:
    """Detect platform: 'windows', 'linux', 'macos', or 'unknown'."""
    system = platform.system().lower()
    if system == 'darwin':
        return 'macos'
    elif system == 'windows':
        return 'windows'
    elif system == 'linux':
        return 'linux'
    return 'unknown'


def is_mac_apple_silicon() -> bool:
    """Check if running on macOS with Apple Silicon."""
    if platform.system().lower() != 'darwin':
        return False
    try:
        # Check for Apple Silicon
        result = subprocess.run(['uname', '-m'], capture_output=True, text=True)
        return result.stdout.strip() == 'arm64'
    except Exception:
        return False


# ==============================================================================
# Configuration
# ==============================================================================

def load_config() -> Dict[str, Any]:
    """Load config.json from project root if present."""
    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    config_path = project_root / 'config.json'
    
    defaults = {
        'llama_cpp_dir': None,
        'models_dir': str(project_root / 'models'),
        'default_quantization': 'Q4_K_M',
    }
    
    if config_path.exists():
        try:
            with open(config_path) as f:
                config = json.load(f)
                defaults.update(config)
                logger.debug(f"Loaded config from {config_path}")
        except Exception as e:
            logger.warning(f"Failed to load config.json: {e}")
    
    return defaults


def find_llama_cpp_dir(cli_path: Optional[str] = None) -> Optional[Path]:
    """Find llama.cpp directory from CLI arg, config, or common locations."""
    if cli_path:
        return Path(cli_path).expanduser().resolve()
    
    # Try config
    config = load_config()
    if config.get('llama_cpp_dir'):
        path = Path(config['llama_cpp_dir']).expanduser().resolve()
        if path.exists():
            return path
    
    # Common locations
    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    candidates = [
        project_root / 'llama.cpp',
        project_root / 'llama-cpp',
        Path.home() / 'llama.cpp',
        Path.home() / 'llama-cpp',
        Path('/usr/local/llama.cpp'),
        Path('/opt/llama.cpp'),
    ]
    
    for candidate in candidates:
        if candidate.exists() and (candidate / 'convert_hf_to_gguf.py').exists():
            return candidate
    
    return None


def get_llama_cpp_tools(llama_cpp_dir: Path) -> Tuple[Optional[Path], Optional[Path]]:
    """Get paths to convert_hf_to_gguf.py and llama-quantize binary."""
    convert_script = llama_cpp_dir / 'convert_hf_to_gguf.py'
    
    # Find llama-quantize (varies by platform and build)
    quantize_binary = None
    quantize_names = ['llama-quantize', 'llama-quantize.exe', 'quantize', 'quantize.exe']
    
    for name in quantize_names:
        candidate = llama_cpp_dir / name
        if candidate.exists():
            quantize_binary = candidate
            break
        # Check build/bin directories
        for subdir in ['build', 'build/bin', 'bin', 'Release', 'Debug']:
            candidate = llama_cpp_dir / subdir / name
            if candidate.exists():
                quantize_binary = candidate
                break
        if quantize_binary:
            break
    
    return convert_script, quantize_binary


# ==============================================================================
# Model Format Detection (simplified)
# ==============================================================================

def detect_model_format(file_path: str) -> Tuple[str, bool]:
    """
    Detect model format from file extension or directory structure.
    Returns: (format_type, is_valid)
    """
    path = Path(file_path)
    
    # If directory: check for config.json (HF model) and shard index files
    if path.is_dir():
        has_config = (path / 'config.json').exists()

        # Check for MLX model directory: has safetensors weights + tokenizer (no conversion needed on macOS)
        # MLX models typically contain *.safetensors + config.json + tokenizer files
        has_safetensors = bool(list(path.glob('*.safetensors')))
        has_tokenizer = (path / 'tokenizer.json').exists() or (path / 'tokenizer_config.json').exists() or (path / 'tokenizer.model').exists()
        is_mlx_dir = (
            has_safetensors and has_config
            or has_safetensors and has_tokenizer
            # Also match if directory name contains 'mlx' (common naming convention)
            or 'mlx' in path.name.lower()
        )
        if is_mlx_dir:
            return ('mlx', True)

        # Check for sharded models
        if SHARD_LOADER_AVAILABLE:
            try:
                info = ShardedModelInfo(file_path)
                if info.is_sharded:
                    return (f'sharded-{info.shard_format}', True)
            except Exception:
                pass
        
        # Check for safetensors index (non-MLX sharded)
        if list(path.glob('model-*.safetensors')) or (path / 'model.safetensors').exists():
            return ('safetensor', True)
        if list(path.glob('pytorch_model-*.bin')) or (path / 'pytorch_model.bin').exists():
            return ('fp16', True)
        
        # Generic HF model directory
        if has_config:
            return ('hf-directory', True)
        
        return ('directory', False)
    
    # If file: use extension
    ext = path.suffix.lower()
    
    if ext == '.gguf':
        return ('gguf', True)
    elif ext == '.safetensors':
        return ('safetensor', True)
    elif ext in ['.bin', '.pt', '.pth']:
        return ('fp16', True)
    elif ext == '.npz':
        return ('npz', True)  # MLX format
    else:
        # Try to detect sharded model by checking parent directory
        if SHARD_LOADER_AVAILABLE:
            try:
                info = ShardedModelInfo(path.parent)
                if info.is_sharded:
                    return (f'sharded-{info.shard_format}', True)
            except Exception:
                pass
        return ('unknown', False)


# ==============================================================================
# Validation
# ==============================================================================

def validate_gguf(gguf_path: Path) -> bool:
    """Validate GGUF file by checking magic bytes."""
    if not gguf_path.exists():
        logger.error(f"Output file not created: {gguf_path}")
        return False
    
    if gguf_path.stat().st_size < 1000:
        logger.error(f"Output file appears empty or corrupt: {gguf_path}")
        return False
    
    try:
        with open(gguf_path, 'rb') as f:
            magic = f.read(4)
            if magic != b'GGUF':
                logger.error(f"Invalid GGUF magic header in: {gguf_path}")
                return False
    except Exception as e:
        logger.error(f"Failed to validate GGUF file: {e}")
        return False
    
    logger.info(f"✓ GGUF validation passed: {gguf_path.name}")
    return True


def validate_mlx(mlx_path: Path) -> bool:
    """Validate MLX output contains expected files."""
    if mlx_path.is_dir():
        # Check for weights.npz or .safetensors files
        has_weights = (mlx_path / 'weights.npz').exists()
        has_safetensors = any(mlx_path.glob('*.safetensors'))
        has_config = (mlx_path / 'config.json').exists()
        
        if not (has_weights or has_safetensors):
            logger.error(f"MLX output missing weights: {mlx_path}")
            return False
        if not has_config:
            logger.warning(f"MLX output missing config.json: {mlx_path}")
        
        logger.info(f"✓ MLX validation passed: {mlx_path.name}")
        return True
    else:
        # Single file output
        if not mlx_path.exists():
            logger.error(f"MLX output not created: {mlx_path}")
            return False
        logger.info(f"✓ MLX validation passed: {mlx_path.name}")
        return True


# ==============================================================================
# Streaming Subprocess Helpers
# ==============================================================================

def run_with_streaming(cmd: list, progress: ProgressReporter, 
                       start_pct: int = 10, end_pct: int = 90) -> Tuple[bool, str]:
    """Run a subprocess with real-time output streaming and progress updates."""
    logger.info(f"Running: {' '.join(str(c) for c in cmd[:5])}...")
    
    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            universal_newlines=True
        )
        
        output_lines = []
        line_count = 0
        
        for line in iter(process.stdout.readline, ''):
            line = line.strip()
            if line:
                output_lines.append(line)
                logger.debug(line)
                # Update progress based on output indicators
                line_count += 1
                if line_count % 100 == 0:
                    pct = start_pct + (end_pct - start_pct) * min(line_count / 1000, 0.9)
                    progress(int(pct))
        
        process.wait()
        
        if process.returncode != 0:
            error_output = '\n'.join(output_lines[-20:])  # Last 20 lines
            logger.error(f"Command failed with code {process.returncode}:\n{error_output}")
            return False, '\n'.join(output_lines)
        
        progress(end_pct)
        return True, '\n'.join(output_lines)
        
    except Exception as e:
        logger.error(f"Failed to run command: {e}")
        return False, str(e)


# ==============================================================================
# Windows/Linux: llama.cpp Backend
# ==============================================================================

def convert_with_llamacpp(
    input_path: Path,
    output_path: Path,
    quantization: str,
    llama_cpp_dir: Path,
    progress: ProgressReporter
) -> bool:
    """
    Convert model to GGUF using llama.cpp's convert_hf_to_gguf.py.
    Then quantize using llama-quantize if needed.
    """
    convert_script, quantize_binary = get_llama_cpp_tools(llama_cpp_dir)
    
    if not convert_script or not convert_script.exists():
        logger.error(f"convert_hf_to_gguf.py not found in {llama_cpp_dir}")
        return False
    
    # Determine if input is a directory or file
    input_is_dir = input_path.is_dir()
    
    # Create temporary F16 GGUF first
    temp_gguf = output_path.with_suffix('.f16.gguf')
    
    try:
        # Step 1: Convert to F16 GGUF
        progress.step("Step 1/2: Converting to F16 GGUF format...", 10)
        
        cmd = [
            sys.executable,
            str(convert_script),
            str(input_path),
            '--outfile', str(temp_gguf),
            '--outtype', 'f16'
        ]
        
        success, _ = run_with_streaming(cmd, progress, 10, 60)
        if not success:
            logger.error("F16 conversion failed")
            return False
        
        if not validate_gguf(temp_gguf):
            return False
        
        # Step 2: Quantize if needed
        if quantization == 'F16':
            # Just rename the temp file
            shutil.move(str(temp_gguf), str(output_path))
            progress.step("✓ F16 model ready (no quantization needed)", 100)
        elif quantize_binary and quantize_binary.exists():
            progress.step(f"Step 2/2: Quantizing to {quantization}...", 60)
            
            cmd = [
                str(quantize_binary),
                str(temp_gguf),
                str(output_path),
                quantization
            ]
            
            success, _ = run_with_streaming(cmd, progress, 60, 95)
            if not success:
                logger.error("Quantization failed")
                return False
            
            # Clean up temp F16 file
            if temp_gguf.exists():
                temp_gguf.unlink()
            
            if not validate_gguf(output_path):
                return False
            
            progress.step(f"✓ Quantization complete: {quantization}", 100)
        else:
            # No quantize binary, keep F16
            shutil.move(str(temp_gguf), str(output_path))
            logger.warning("llama-quantize not found, keeping F16 format")
            progress.step("✓ F16 model ready (quantization skipped)", 100)
        
        return True
        
    except Exception as e:
        logger.error(f"Conversion failed: {e}")
        # Cleanup on failure
        if temp_gguf.exists():
            temp_gguf.unlink()
        if output_path.exists():
            output_path.unlink()
        return False


def quantize_gguf_with_llamacpp(
    input_path: Path,
    output_path: Path,
    quantization: str,
    llama_cpp_dir: Path,
    progress: ProgressReporter
) -> bool:
    """Quantize an existing GGUF file using llama-quantize."""
    _, quantize_binary = get_llama_cpp_tools(llama_cpp_dir)
    
    if not quantize_binary or not quantize_binary.exists():
        logger.error(f"llama-quantize not found in {llama_cpp_dir}")
        return False
    
    if not validate_gguf(input_path):
        return False
    
    try:
        progress.step(f"Quantizing GGUF to {quantization}...", 10)
        
        cmd = [
            str(quantize_binary),
            str(input_path),
            str(output_path),
            quantization
        ]
        
        success, _ = run_with_streaming(cmd, progress, 10, 95)
        if not success:
            logger.error("Quantization failed")
            return False
        
        if not validate_gguf(output_path):
            return False
        
        progress.step("✓ Quantization complete", 100)
        return True
        
    except Exception as e:
        logger.error(f"Quantization failed: {e}")
        return False


# ==============================================================================
# macOS: MLX Backend
# ==============================================================================

def check_mlx_dependencies() -> bool:
    """Check if MLX dependencies are available."""
    try:
        import mlx_lm
        return True
    except ImportError:
        logger.error("mlx-lm not installed. Run: pip install mlx-lm")
        return False


def convert_with_mlx(
    input_path: Path,
    output_path: Path,
    quantization: Optional[str],
    progress: ProgressReporter
) -> bool:
    """
    On macOS, MLX loads safetensors directly.
    If quantization is requested, use mlx_lm.utils.quantize_model.
    Otherwise, just copy/validate the input.
    """
    if not check_mlx_dependencies():
        return False
    
    try:
        from mlx_lm.utils import quantize_model as mlx_quantize
        
        # Check input format
        fmt, valid = detect_model_format(str(input_path))
        if not valid:
            logger.error(f"Invalid input format: {fmt}")
            return False
        
        # If no quantization requested and already safetensors, just copy
        if not quantization or quantization == 'F16':
            progress.step("Copying safetensors for MLX (no conversion needed)...", 50)
            
            if input_path.is_dir():
                # Copy entire directory
                if output_path.exists():
                    shutil.rmtree(output_path)
                shutil.copytree(input_path, output_path)
            else:
                # Copy single file
                shutil.copy2(input_path, output_path)
            
            progress.step("✓ Model ready for MLX", 100)
            return validate_mlx(output_path)
        
        # Quantization requested
        progress.step(f"Quantizing with MLX to {quantization}...", 10)
        
        # Map quantization string to bits
        quant_map = {
            'Q4_0': 4, 'Q4_K_M': 4, 'Q4_K_S': 4,
            'Q8_0': 8, 'Q8_K': 8,
            'Q5_0': 5, 'Q5_K_M': 5,
            'Q6_K': 6,
            'Q2_K': 2,
        }
        bits = quant_map.get(quantization, 4)
        
        mlx_quantize(str(input_path), str(output_path), q_bits=bits)
        
        progress.step(f"✓ Quantized to {bits}-bit", 100)
        return validate_mlx(output_path)
        
    except Exception as e:
        logger.error(f"MLX conversion failed: {e}")
        return False


def quantize_with_mlx(
    input_path: Path,
    output_path: Path,
    bits: int,
    progress: ProgressReporter
) -> bool:
    """Quantize a safetensors model using MLX (macOS only)."""
    if not check_mlx_dependencies():
        return False
    
    try:
        from mlx_lm.utils import quantize_model as mlx_quantize
        
        progress.step(f"Quantizing to {bits}-bit with MLX...", 10)
        
        mlx_quantize(str(input_path), str(output_path), q_bits=bits)
        
        progress.step("✓ Quantization complete", 100)
        return validate_mlx(output_path)
        
    except Exception as e:
        logger.error(f"MLX quantization failed: {e}")
        return False


# ==============================================================================
# Sharded Model Handling (preserved)
# ==============================================================================

def merge_shards_to_temp(
    input_path: Path,
    progress: ProgressReporter
) -> Optional[Path]:
    """Merge sharded model into a temporary directory for conversion."""
    if not SHARD_LOADER_AVAILABLE:
        logger.error("Shard loader not available")
        return None
    
    try:
        progress.step("Merging model shards...", 10)
        
        converter = ShardedModelConverter(str(input_path))
        merged_dir = Path(tempfile.mkdtemp(prefix="lumina_merge_"))
        
        # Merge and save as single safetensors
        state_dict = converter.load_shards()
        
        # Save using safetensors
        from safetensors.torch import save_file
        import torch
        
        output_file = merged_dir / 'model.safetensors'
        save_file(state_dict, str(output_file))
        
        # Copy config.json if present
        config_src = input_path / 'config.json'
        if config_src.exists():
            shutil.copy2(config_src, merged_dir / 'config.json')
        
        progress.step(f"✓ Merged {len(state_dict)} parameters", 50)
        return merged_dir
        
    except Exception as e:
        logger.error(f"Shard merging failed: {e}")
        return None


# ==============================================================================
# Main Conversion Interface
# ==============================================================================

def convert_model(
    input_path: str,
    output_path: str,
    quantization: str = 'Q4_K_M',
    llama_cpp_dir: Optional[str] = None,
    report_progress_enabled: bool = False,
    force: bool = False
) -> bool:
    """
    Main conversion entry point. Routes to appropriate backend based on platform.
    
    Args:
        input_path: Input model file or directory
        output_path: Output file path (GGUF on Win/Linux, safetensors/npz on macOS)
        quantization: Quantization type (Q4_K_M, Q8_0, F16, etc.)
        llama_cpp_dir: Path to llama.cpp directory (Win/Linux only)
        report_progress_enabled: Enable progress reporting
        force: Overwrite existing output
    
    Returns:
        True if conversion successful
    """
    input_p = Path(input_path).expanduser().resolve()
    output_p = Path(output_path).expanduser().resolve()
    
    # Validate input
    if not input_p.exists():
        logger.error(f"Input not found: {input_p}")
        return False
    
    # Check output exists
    if output_p.exists() and not force:
        logger.error(f"Output exists (use --force): {output_p}")
        return False
    
    # Ensure output directory exists
    output_p.parent.mkdir(parents=True, exist_ok=True)
    
    # Detect format
    fmt, valid = detect_model_format(str(input_p))
    if not valid:
        logger.error(f"Unsupported format: {fmt}")
        return False
    
    if fmt == 'gguf':
        logger.info("Input is already GGUF, copying...")
        shutil.copy2(input_p, output_p)
        return validate_gguf(output_p)
    
    # Setup progress reporter
    progress = ProgressReporter(report_progress_enabled)
    
    # Route to platform-specific backend
    plat = get_platform()
    
    if plat == 'macos':
        logger.info(f"Using MLX backend (macOS) for {fmt} -> MLX")
        return convert_with_mlx(input_p, output_p, quantization, progress)
    
    else:
        # Windows/Linux: llama.cpp backend
        llama_dir = find_llama_cpp_dir(llama_cpp_dir)
        if not llama_dir:
            logger.error("llama.cpp directory not found. Use --llama-cpp-dir or set in config.json")
            return False
        
        logger.info(f"Using llama.cpp backend ({plat}) from {llama_dir}")
        logger.info(f"Converting {fmt} -> GGUF ({quantization})")
        
        # Handle sharded models
        if fmt.startswith('sharded-'):
            import tempfile
            merged = merge_shards_to_temp(input_p, progress)
            if not merged:
                return False
            try:
                result = convert_with_llamacpp(
                    merged, output_p, quantization, llama_dir, progress
                )
            finally:
                # Cleanup temp merged directory
                if merged and merged.exists():
                    shutil.rmtree(merged)
            return result
        
        return convert_with_llamacpp(input_p, output_p, quantization, llama_dir, progress)


def quantize_model(
    input_path: str,
    output_path: str,
    quantization: str,
    llama_cpp_dir: Optional[str] = None,
    bits: Optional[int] = None,
    report_progress_enabled: bool = False,
    force: bool = False
) -> bool:
    """
    Quantize an existing model file.
    
    On Win/Linux: GGUF -> quantized GGUF using llama-quantize
    On macOS: safetensors -> quantized safetensors using MLX
    """
    input_p = Path(input_path).expanduser().resolve()
    output_p = Path(output_path).expanduser().resolve()
    
    if not input_p.exists():
        logger.error(f"Input not found: {input_p}")
        return False
    
    if output_p.exists() and not force:
        logger.error(f"Output exists (use --force): {output_p}")
        return False
    
    output_p.parent.mkdir(parents=True, exist_ok=True)
    
    progress = ProgressReporter(report_progress_enabled)
    plat = get_platform()
    
    if plat == 'macos':
        # MLX quantization
        if bits is None:
            # Map quantization string to bits
            quant_map = {'Q4_0': 4, 'Q4_K_M': 4, 'Q8_0': 8, 'Q5_0': 5, 'Q6_K': 6, 'Q2_K': 2}
            bits = quant_map.get(quantization, 4)
        return quantize_with_mlx(input_p, output_p, bits, progress)
    
    else:
        # llama.cpp quantization
        llama_dir = find_llama_cpp_dir(llama_cpp_dir)
        if not llama_dir:
            logger.error("llama.cpp directory not found")
            return False
        
        # Input must be GGUF
        fmt, _ = detect_model_format(str(input_p))
        if fmt != 'gguf':
            logger.error(f"Input must be GGUF for quantization, got: {fmt}")
            return False
        
        return quantize_gguf_with_llamacpp(input_p, output_p, quantization, llama_dir, progress)


# ==============================================================================
# CLI
# ==============================================================================

def main():
    parser = argparse.ArgumentParser(
        description='Lumina Edge Model Converter — Cross-platform LLM format converter',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Platform Backends:
  Windows/Linux: llama.cpp (convert_hf_to_gguf.py + llama-quantize)
  macOS: mlx-lm (MLX backend, loads safetensors directly)

Examples:
  # Convert to GGUF (Win/Linux) or copy for MLX (macOS)
  python model-converter.py convert model_dir/ output.gguf --llama-cpp-dir ~/llama.cpp

  # Convert with specific quantization
  python model-converter.py convert model.safetensors model.gguf -q Q8_0

  # Quantize existing GGUF (Win/Linux) or safetensors (macOS)
  python model-converter.py quantize input.gguf output.gguf --quantization Q4_K_M

  # MLX-specific bit quantization (macOS only)
  python model-converter.py quantize model.safetensors model-q4.safetensors --bits 4

  # Analyze sharded model
  python model-converter.py shards /path/to/sharded_model
        '''
    )
    
    subparsers = parser.add_subparsers(dest='command', required=True, help='Command')
    
    # Convert command
    convert_p = subparsers.add_parser('convert', help='Convert model to target format')
    convert_p.add_argument('input', help='Input model file or directory')
    convert_p.add_argument('output', help='Output file path')
    convert_p.add_argument('-q', '--quantization', default='Q4_K_M',
                          choices=['F16', 'F32', 'Q4_0', 'Q4_K_M', 'Q4_K_S', 
                                   'Q5_0', 'Q5_K_M', 'Q6_K', 'Q8_0', 'Q8_K', 'Q2_K'],
                          help='Quantization type (default: Q4_K_M)')
    convert_p.add_argument('--llama-cpp-dir', help='Path to llama.cpp directory (Win/Linux)')
    convert_p.add_argument('--force', action='store_true', help='Overwrite existing output')
    convert_p.add_argument('--report-progress', action='store_true', help='Report progress')
    convert_p.add_argument('--check', action='store_true', help='Check dependencies and exit')
    
    # Quantize command
    quantize_p = subparsers.add_parser('quantize', help='Quantize existing model')
    quantize_p.add_argument('input', help='Input model file')
    quantize_p.add_argument('output', help='Output file path')
    quantize_p.add_argument('--quantization', '-q', default='Q4_K_M',
                           choices=['F16', 'F32', 'Q4_0', 'Q4_K_M', 'Q4_K_S',
                                    'Q5_0', 'Q5_K_M', 'Q6_K', 'Q8_0', 'Q8_K', 'Q2_K'],
                           help='Quantization type (Win/Linux)')
    quantize_p.add_argument('--bits', type=int, choices=[2, 3, 4, 6, 8],
                           help='Bit precision (macOS MLX only, default: 4)')
    quantize_p.add_argument('--llama-cpp-dir', help='Path to llama.cpp directory (Win/Linux)')
    quantize_p.add_argument('--force', action='store_true', help='Overwrite existing output')
    quantize_p.add_argument('--report-progress', action='store_true', help='Report progress')
    
    # Shards command
    shards_p = subparsers.add_parser('shards', help='Analyze sharded model')
    shards_p.add_argument('path', help='Path to model directory')
    shards_p.add_argument('--load', action='store_true', help='Load and validate shards')
    
    args = parser.parse_args()
    
    # Check mode
    if args.command == 'convert' and args.check:
        plat = get_platform()
        print(f"Platform: {plat}")
        if plat == 'macos':
            if check_mlx_dependencies():
                print("✓ MLX dependencies available")
                return 0
            else:
                print("✗ MLX dependencies missing")
                return 1
        else:
            llama_dir = find_llama_cpp_dir(args.llama_cpp_dir)
            if llama_dir:
                convert_script, quantize_binary = get_llama_cpp_tools(llama_dir)
                print(f"llama.cpp dir: {llama_dir}")
                print(f"  convert_hf_to_gguf.py: {'✓' if convert_script else '✗'} {convert_script or 'NOT FOUND'}")
                print(f"  llama-quantize: {'✓' if quantize_binary else '✗'} {quantize_binary or 'NOT FOUND'}")
                if convert_script and quantize_binary:
                    return 0
                return 1
            else:
                print("✗ llama.cpp directory not found")
                return 1
    
    # Execute command
    if args.command == 'convert':
        success = convert_model(
            args.input,
            args.output,
            quantization=args.quantization,
            llama_cpp_dir=args.llama_cpp_dir,
            report_progress_enabled=args.report_progress,
            force=args.force
        )
        return 0 if success else 1
    
    elif args.command == 'quantize':
        success = quantize_model(
            args.input,
            args.output,
            quantization=args.quantization,
            llama_cpp_dir=args.llama_cpp_dir,
            bits=args.bits,
            report_progress_enabled=args.report_progress,
            force=args.force
        )
        return 0 if success else 1
    
    elif args.command == 'shards':
        if not SHARD_LOADER_AVAILABLE:
            logger.error("Shard loader not available")
            return 1
        
        try:
            info = ShardedModelInfo(args.path)
            print(f"\nSharded Model Analysis: {args.path}")
            print(f"  Is sharded: {info.is_sharded}")
            print(f"  Format: {info.shard_format}")
            print(f"  Total shards: {info.total_shards}")
            print(f"  Index file: {info.index_file or 'N/A'}")
            
            if info.is_sharded and args.load:
                converter = ShardedModelConverter(args.path)
                mem_estimate, mem_str = converter.get_memory_estimate()
                print(f"  Memory required: {mem_str}")
                state_dict = converter.load_shards()
                print(f"  ✓ Loaded {len(state_dict)} parameters successfully")
            
            return 0
        except Exception as e:
            logger.error(f"Failed to analyze shards: {e}")
            return 1
    
    return 1


if __name__ == '__main__':
    sys.exit(main())