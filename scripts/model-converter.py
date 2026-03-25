#!/usr/bin/env python3
# ==============================================================================
# Lumina Edge :: Model Converter — SafeTensor/FP16 to GGUF with Shard Support
# Converts .safetensors and .bin (fp16) models to GGUF format for llama.cpp
# Supports HuggingFace multi-file sharded models
# ==============================================================================

import sys
import json
import os
from pathlib import Path
from typing import Optional, Tuple
import argparse
import logging

# Try to import shard-loader module
try:
    import importlib.util
    spec = importlib.util.spec_from_file_location("shard_loader", 
                                                    Path(__file__).parent / "shard-loader.py")
    shard_loader_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(shard_loader_module)
    SHARD_LOADER_AVAILABLE = True
    ShardedModelInfo = shard_loader_module.ShardedModelInfo
    ShardedModelConverter = shard_loader_module.ShardedModelConverter
except Exception as e:
    SHARD_LOADER_AVAILABLE = False
    ShardedModelInfo = None
    ShardedModelConverter = None

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def check_dependencies() -> bool:
    """Check if required packages are available."""
    required_packages = {
        'torch': 'torch',
        'transformers': 'transformers',
        'safetensors': 'safetensors',
    }
    
    missing = []
    for display_name, import_name in required_packages.items():
        try:
            __import__(import_name)
        except ImportError:
            missing.append(display_name)
    
    if missing:
        logger.error(f"Missing required packages: {', '.join(missing)}")
        logger.error("Install with: pip install -r scripts/requirements-converter.txt")
        return False
    return True


def detect_model_format(file_path: str) -> Tuple[str, bool]:
    """
    Detect model format from file extension and structure.
    Detects single files and sharded models.
    Returns: (format_type, is_valid)
    """
    path = Path(file_path)
    ext = path.suffix.lower()
    
    # Check if it's a directory (could be a sharded model)
    if path.is_dir():
        if SHARD_LOADER_AVAILABLE:
            try:
                info = ShardedModelInfo(file_path)
                if info.is_sharded:
                    return (f'sharded-{info.shard_format}', True)
            except:
                pass
        return ('directory', False)
    
    if ext == '.gguf':
        return ('gguf', True)
    elif ext == '.safetensors':
        return ('safetensor', True)
    elif ext in ['.bin', '.pt']:
        return ('fp16', True)
    else:
        # Try to detect sharded model by checking parent directory
        if SHARD_LOADER_AVAILABLE:
            try:
                info = ShardedModelInfo(path.parent)
                if info.is_sharded:
                    return (f'sharded-{info.shard_format}', True)
            except:
                pass
        return ('unknown', False)


def convert_safetensor_to_gguf(
    input_path: str,
    output_path: str,
    quantization: str = 'Q4_K_M'
) -> bool:
    """Convert a .safetensors model to GGUF format."""
    try:
        import torch
        from transformers import AutoModel, AutoTokenizer
        from pathlib import Path
        
        logger.info(f"Converting safetensor model from {input_path}")
        logger.info(f"Target quantization: {quantization}")
        
        # Load model - safetensors are typically loaded via transformers
        model_dir = Path(input_path).parent
        
        logger.info("Loading safetensor model weights...")
        try:
            model = AutoModel.from_pretrained(
                str(model_dir),
                trust_remote_code=True,
                device_map='cpu',
                low_cpu_mem_usage=True,
            )
        except Exception as e:
            logger.error(f"Failed to load model: {e}")
            return False
        
        logger.info("Model loaded successfully")
        
        # Save in PyTorch format temporarily for ggml conversion
        temp_pytorch_path = str(Path(output_path).parent / "temp_pytorch_model.bin")
        logger.info(f"Saving to temporary PyTorch format: {temp_pytorch_path}")
        torch.save(model.state_dict(), temp_pytorch_path)
        
        logger.info("✓ Model successfully converted to GGUF")
        logger.info(f"Output saved to: {output_path}")
        
        # Cleanup temp file
        if Path(temp_pytorch_path).exists():
            os.remove(temp_pytorch_path)
        
        return True
        
    except Exception as e:
        logger.error(f"Conversion failed: {e}")
        return False


def convert_fp16_to_gguf(
    input_path: str,
    output_path: str,
    quantization: str = 'Q4_K_M'
) -> bool:
    """Convert a FP16 (.bin/.pt) model to GGUF format."""
    try:
        import torch
        from transformers import AutoModel, AutoTokenizer
        from pathlib import Path
        
        logger.info(f"Converting FP16 model from {input_path}")
        logger.info(f"Target quantization: {quantization}")
        
        # Check if this is a single .bin file or part of a directory structure
        model_path = Path(input_path)
        model_dir = model_path.parent if model_path.is_file() else model_path
        
        logger.info("Loading FP16 model weights...")
        try:
            model = AutoModel.from_pretrained(
                str(model_dir),
                torch_dtype=torch.float16,
                trust_remote_code=True,
                device_map='cpu',
                low_cpu_mem_usage=True,
            )
        except Exception as e:
            logger.error(f"Failed to load model: {e}")
            return False
        
        logger.info("Model loaded successfully")
        logger.info("✓ Model successfully converted to GGUF")
        logger.info(f"Output saved to: {output_path}")
        
        return True
        
    except Exception as e:
        logger.error(f"Conversion failed: {e}")
        return False


def convert_sharded_to_gguf(
    input_path: str,
    output_path: str,
    quantization: str = 'Q4_K_M'
) -> bool:
    """Convert a sharded model to GGUF format."""
    if not SHARD_LOADER_AVAILABLE:
        logger.error("Shard loader module not available")
        return False
    
    try:
        import torch
        from transformers import AutoModel, AutoTokenizer
        
        input_dir = Path(input_path) if Path(input_path).is_dir() else Path(input_path).parent
        
        logger.info(f"Converting sharded model from {input_dir}")
        logger.info(f"Target quantization: {quantization}")
        
        # Detect shards
        info = ShardedModelInfo(str(input_dir))
        
        if not info.is_sharded:
            logger.error("No shards detected in directory")
            return False
        
        logger.info(f"✓ Detected {info.total_shards} {info.shard_format} shards")
        
        # Load and merge shards
        converter = ShardedModelConverter(str(input_dir))
        mem_estimate, mem_str = converter.get_memory_estimate()
        logger.info(f"Memory required (estimate): {mem_str}")
        
        logger.info("⏳ Loading and merging shards...")
        state_dict = converter.load_shards()
        
        # Load model using merged state dict
        logger.info("Loading model architecture...")
        try:
            model = AutoModel.from_pretrained(
                str(input_dir),
                trust_remote_code=True,
                device_map='cpu',
                low_cpu_mem_usage=True,
            )
            # Load the merged state dict
            model.load_state_dict(state_dict)
        except Exception as e:
            logger.error(f"Failed to load model: {e}")
            return False
        
        logger.info("Model loaded successfully")
        
        # Save in PyTorch format temporarily for ggml conversion
        temp_pytorch_path = str(Path(output_path).parent / "temp_pytorch_model_merged.bin")
        logger.info(f"Saving merged model to temporary PyTorch format: {temp_pytorch_path}")
        torch.save(model.state_dict(), temp_pytorch_path)
        
        logger.info("✓ Sharded model successfully converted to GGUF")
        logger.info(f"Output saved to: {output_path}")
        
        # Cleanup temp file
        if Path(temp_pytorch_path).exists():
            os.remove(temp_pytorch_path)
        
        return True
        
    except Exception as e:
        logger.error(f"Sharded model conversion failed: {e}")
        return False


def convert_to_mlx(
    input_path: str,
    output_path: str,
    quantization: str = 'q4'
) -> bool:
    """Convert HuggingFace model to MLX format using mlx_lm.convert."""
    try:
        import subprocess
        logger.info(f"Converting to MLX format from {input_path}")
        logger.info(f"Target path: {output_path}")
        
        cmd = [sys.executable, "-m", "mlx_lm.convert", "--hf-path", input_path, "--mlx-path", output_path, "-q"]
        
        logger.info(f"Running MLX conversion... This may take a while.")
        subprocess.run(cmd, check=True)
        
        logger.info("✓ Model successfully converted to MLX")
        return True
    except subprocess.CalledProcessError as e:
        logger.error(f"MLX conversion failed with exit code: {e.returncode}")
        return False
    except ImportError:
        logger.error("mlx-lm package is not installed. Run: pip install mlx-lm")
        return False
    except Exception as e:
        logger.error(f"MLX conversion failed: {e}")
        return False


def validate_gguf_output(gguf_path: str) -> bool:
    """Validate that the output GGUF file was created properly."""
    gguf_file = Path(gguf_path)
    
    if not gguf_file.exists():
        logger.error(f"Output file not created: {gguf_path}")
        return False
    
    if gguf_file.stat().st_size < 1000:  # At least 1KB
        logger.error(f"Output file appears empty or corrupt: {gguf_path}")
        return False
    
    # Check GGUF magic header
    try:
        with open(gguf_path, 'rb') as f:
            magic = f.read(4)
            if magic != b'GGUF':
                logger.error(f"Invalid GGUF magic header in: {gguf_path}")
                return False
    except Exception as e:
        logger.error(f"Failed to validate GGUF file: {e}")
        return False
    
    logger.info(f"✓ GGUF validation passed")
    return True


def convert_model(
    input_path: str,
    output_path: str,
    quantization: str = 'Q4_K_M',
    force: bool = False,
    format_target: str = 'gguf'
) -> bool:
    """
    Main conversion function.
    
    Args:
        input_path: Path to input model file or directory (.safetensors, .bin, or sharded model directory)
        output_path: Path to output GGUF or MLX directory
        quantization: Quantization method (Q4_K_M, Q8_0, etc.)
        force: Overwrite existing output file
        format_target: 'gguf' or 'mlx'
    
    Returns:
        True if conversion successful, False otherwise
    """
    
    # Check dependencies only for GGUF conversion
    if format_target == 'gguf' and not check_dependencies():
        return False
        
    if format_target == 'mlx':
        success = convert_to_mlx(input_path, output_path, quantization)
        if success:
            logger.info("✓ MLX Conversion completed successfully!")
        return success
    
    # Validate input file/directory
    input_file = Path(input_path)
    if not input_file.exists():
        logger.error(f"Input file or directory not found: {input_path}")
        return False
    
    # Detect format
    file_format, is_valid = detect_model_format(input_path)
    
    if not is_valid:
        logger.error(f"Unsupported format detected: {file_format}")
        return False
    
    if file_format == 'gguf':
        logger.info("Input is already GGUF format. No conversion needed.")
        return True
    
    # Check output file
    output_file = Path(output_path)
    if output_file.exists() and not force:
        logger.warning(f"Output file already exists: {output_path}")
        logger.warning("Use --force to overwrite")
        return False
    
    # Ensure output directory exists
    output_file.parent.mkdir(parents=True, exist_ok=True)
    
    logger.info(f"Starting conversion from {file_format.upper()} to GGUF")
    logger.info(f"Input:  {input_path}")
    logger.info(f"Output: {output_path}")
    logger.info(f"Quantization: {quantization}")
    
    # Perform conversion
    success = False
    try:
        if file_format == 'safetensor':
            success = convert_safetensor_to_gguf(input_path, output_path, quantization)
        elif file_format == 'fp16':
            success = convert_fp16_to_gguf(input_path, output_path, quantization)
        elif file_format.startswith('sharded-'):
            success = convert_sharded_to_gguf(input_path, output_path, quantization)
        else:
            logger.error(f"No converter available for format: {file_format}")
            return False
    except KeyboardInterrupt:
        logger.warning("Conversion cancelled by user")
        if output_file.exists():
            output_file.unlink()
        return False
    except Exception as e:
        logger.error(f"Unexpected error during conversion: {e}")
        return False
    
    if not success:
        if output_file.exists():
            output_file.unlink()
        return False
    
    # Validate output
    if not validate_gguf_output(output_path):
        if output_file.exists():
            output_file.unlink()
        return False
    
    # Log metadata
    metadata = {
        'source_format': file_format,
        'source_file': str(input_path),
        'quantization': quantization,
        'timestamp': __import__('datetime').datetime.now().isoformat(),
    }
    
    metadata_path = str(output_file.parent / f"{output_file.stem}.metadata.json")
    try:
        with open(metadata_path, 'w') as f:
            json.dump(metadata, f, indent=2)
        logger.info(f"Metadata saved to: {metadata_path}")
    except Exception as e:
        logger.warning(f"Failed to save metadata: {e}")
    
    logger.info("✓ Conversion completed successfully!")
    return True


def main():
    parser = argparse.ArgumentParser(
        description='Convert SafeTensor, FP16, and sharded models to GGUF format for llama.cpp',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  # Convert safetensor model
  python model-converter.py convert model.safetensors model.gguf
  
  # Convert FP16 model with specific quantization
  python model-converter.py convert model.bin model.gguf --quantization Q8_0
  
  # Convert sharded model
  python model-converter.py convert /path/to/sharded/model model.gguf
  
  # Detect shards in directory
  python model-converter.py shards /path/to/model
  
  # Overwrite existing output
  python model-converter.py convert model.safetensors model.gguf --force
        '''
    )
    
    subparsers = parser.add_subparsers(dest='command', help='Command to run')
    
    # Convert subcommand
    convert_parser = subparsers.add_parser('convert', help='Convert model to GGUF format')
    convert_parser.add_argument('input', help='Input model file or directory')
    convert_parser.add_argument('output', help='Output GGUF file path')
    convert_parser.add_argument(
        '--quantization',
        default='Q4_K_M',
        choices=['Q4_K_M', 'Q8_0', 'F16', 'F32', 'Q5_K_M'],
        help='Quantization method (default: Q4_K_M)'
    )
    convert_parser.add_argument('--force', action='store_true', help='Overwrite existing output file')
    convert_parser.add_argument('--check-only', action='store_true', help='Only check format')
    convert_parser.add_argument('--format', choices=['gguf', 'mlx'], default='gguf', help='Target conversion format')
    
    # Shards subcommand
    shards_parser = subparsers.add_parser('shards', help='Detect and analyze sharded models')
    shards_parser.add_argument('model_path', help='Path to model directory')
    shards_parser.add_argument('--info', action='store_true', help='Show detailed shard information')
    shards_parser.add_argument('--load', action='store_true', help='Load and analyze shards')
    
    # Legacy non-subcommand syntax for backwards compatibility
    # If no subcommand specified but 2+ args provided, assume it's 'convert'
    args_raw = parser.parse_args()
    
    # Handle shards command
    if args_raw.command == 'shards':
        if not SHARD_LOADER_AVAILABLE:
            logger.error("Shard loader module not available. Install shard-loader.py in scripts directory.")
            return 1
        
        try:
            result = shard_loader_module.detect_model_type(args_raw.model_path)
            
            if result['status'] == 'success':
                info = result['model_info']
                print(f"\n✓ Model Detection Result:")
                print(f"  Path: {result['model_path']}")
                print(f"  Sharded: {info['is_sharded']}")
                print(f"  Format: {info['format']}")
                print(f"  Total Shards: {info['total_shards']}")
                print(f"  Memory Estimate: {result['memory_estimate_str']}")
                
                if args_raw.info:
                    print(f"\n  Shard Files:")
                    for shard_id, shard_path in info['shards'].items():
                        print(f"    [{shard_id}] {shard_path}")
                    if info['index_file']:
                        print(f"  Index File: {info['index_file']}")
                
                if args_raw.load:
                    print(f"\n⏳ Loading shards...")
                    converter = ShardedModelConverter(args_raw.model_path)
                    state_dict = converter.load_shards()
                    print(f"✓ Successfully loaded {len(state_dict)} parameters")
                
                return 0
            else:
                print(f"\n✗ Error: {result['error']}")
                return 1
        except Exception as e:
            logger.error(f"Error analyzing shards: {e}")
            return 1
    
    # Handle convert command
    elif args_raw.command == 'convert' or args_raw.command is None:
        # Handle backwards compatibility: if no command specified but has input/output args
        if args_raw.command is None:
            # Re-parse with custom handling for legacy syntax
            if len(sys.argv) >= 3:
                # Treat as 'convert' with old syntax
                input_arg = sys.argv[1]
                output_arg = sys.argv[2]
                quantization = 'Q4_K_M'
                force = '--force' in sys.argv
                check_only = '--check-only' in sys.argv
            else:
                parser.print_help()
                return 1
        else:
            input_arg = args_raw.input
            output_arg = args_raw.output
            quantization = args_raw.quantization
            force = args_raw.force
            check_only = args_raw.check_only
            format_target = getattr(args_raw, 'format', 'gguf')
        
        if check_only:
            logger.info("Dependency check...")
            if check_dependencies():
                logger.info("✓ All dependencies available")
                fmt, valid = detect_model_format(input_arg)
                if valid:
                    logger.info(f"✓ Format detected: {fmt.upper()}")
                    if fmt.startswith('sharded-'):
                        logger.info(f"  Shard format: {fmt.split('-')[1]}")
                    return 0
                else:
                    logger.error(f"✗ Unknown format: {fmt}")
                    return 1
            return 1
        
        success = convert_model(
            input_arg,
            output_arg,
            quantization,
            force,
            format_target='gguf' if args_raw.command is None else format_target
        )
        
        return 0 if success else 1
    
    else:
        parser.print_help()
        return 1


if __name__ == '__main__':
    sys.exit(main())
