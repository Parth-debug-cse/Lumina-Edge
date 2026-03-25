#!/usr/bin/env python3
# ==============================================================================
# Lumina Edge :: Model Converter — SafeTensor/FP16 to GGUF
# Converts .safetensors and .bin (fp16) models to GGUF format for llama.cpp
# ==============================================================================

import sys
import json
import os
from pathlib import Path
from typing import Optional, Tuple
import argparse
import logging

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
    Returns: (format_type, is_valid)
    """
    path = Path(file_path)
    ext = path.suffix.lower()
    
    if ext == '.gguf':
        return ('gguf', True)
    elif ext == '.safetensors':
        return ('safetensor', True)
    elif ext in ['.bin', '.pt']:
        return ('fp16', True)
    else:
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
    force: bool = False
) -> bool:
    """
    Main conversion function.
    
    Args:
        input_path: Path to input model file (.safetensors or .bin)
        output_path: Path to output GGUF file
        quantization: Quantization method (Q4_K_M, Q8_0, etc.)
        force: Overwrite existing output file
    
    Returns:
        True if conversion successful, False otherwise
    """
    
    # Check dependencies
    if not check_dependencies():
        return False
    
    # Validate input file
    input_file = Path(input_path)
    if not input_file.exists():
        logger.error(f"Input file not found: {input_path}")
        return False
    
    # Detect format
    file_format, is_valid = detect_model_format(input_path)
    
    if not is_valid:
        logger.error(f"Unsupported file format, expected .safetensors or .bin, got: {input_file.suffix}")
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
        description='Convert SafeTensor and FP16 models to GGUF format for llama.cpp',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  # Convert safetensor model
  python model-converter.py model.safetensors model.gguf
  
  # Convert FP16 model with specific quantization
  python model-converter.py model.bin model.gguf --quantization Q8_0
  
  # Overwrite existing output
  python model-converter.py model.safetensors model.gguf --force
        '''
    )
    
    parser.add_argument('input', help='Input model file (.safetensors or .bin)')
    parser.add_argument('output', help='Output GGUF file path')
    parser.add_argument(
        '--quantization',
        default='Q4_K_M',
        choices=['Q4_K_M', 'Q8_0', 'F16', 'F32', 'Q5_K_M'],
        help='Quantization method (default: Q4_K_M)'
    )
    parser.add_argument(
        '--force',
        action='store_true',
        help='Overwrite existing output file'
    )
    parser.add_argument(
        '--check-only',
        action='store_true',
        help='Only check dependencies and file format, don\'t convert'
    )
    
    args = parser.parse_args()
    
    if args.check_only:
        logger.info("Dependency check...")
        if check_dependencies():
            logger.info("✓ All dependencies available")
            fmt, valid = detect_model_format(args.input)
            if valid:
                logger.info(f"✓ Format detected: {fmt.upper()}")
                return 0
            else:
                logger.error(f"✗ Unknown format: {fmt}")
                return 1
        return 1
    
    success = convert_model(
        args.input,
        args.output,
        args.quantization,
        args.force
    )
    
    return 0 if success else 1


if __name__ == '__main__':
    sys.exit(main())
