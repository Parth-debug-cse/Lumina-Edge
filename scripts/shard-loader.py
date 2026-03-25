#!/usr/bin/env python3
"""
Shard Loader Module
Handles HuggingFace multi-file sharded model detection, merging, and loading.
Supports safetensors, pytorch, and other shard formats.
"""

import os
import json
import re
import logging
from pathlib import Path
from typing import Dict, List, Tuple, Optional
from collections import defaultdict

try:
    import safetensors
    from safetensors.torch import load_file as load_safetensors
    SAFETENSORS_AVAILABLE = True
except ImportError:
    SAFETENSORS_AVAILABLE = False

try:
    import torch
    TORCH_AVAILABLE = True
except ImportError:
    TORCH_AVAILABLE = False

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)


class ShardedModelInfo:
    """Information about a sharded model"""
    def __init__(self, model_path: str):
        self.model_path = Path(model_path)
        self.parent_dir = self.model_path.parent
        self.shards: Dict[int, Path] = {}
        self.shard_format = None
        self.total_shards = 0
        self.index_file = None
        self.config_file = None
        self.is_sharded = False
        
        self._detect_shards()
    
    def _detect_shards(self):
        """Detect shards in the model directory"""
        if not self.model_path.exists():
            raise FileNotFoundError(f"Model path not found: {self.model_path}")
        
        # If it's a file, use its directory
        if self.model_path.is_file():
            self.parent_dir = self.model_path.parent
        else:
            self.parent_dir = self.model_path
        
        # Check for safetensors shards (model-00001-of-00003.safetensors)
        safetensor_shards = self._find_shard_files(self.parent_dir, r'model-(\d+)-of-(\d+)\.safetensors')
        if safetensor_shards:
            self.shard_format = 'safetensors'
            self.shards = safetensor_shards[0]
            self.total_shards = safetensor_shards[1]
            self.is_sharded = True
            logger.info(f"✓ Detected {self.total_shards} safetensors shards")
            return
        
        # Check for pytorch shards (pytorch_model-00001-of-00003.bin)
        pytorch_shards = self._find_shard_files(self.parent_dir, r'pytorch_model-(\d+)-of-(\d+)\.bin')
        if pytorch_shards:
            self.shard_format = 'pytorch'
            self.shards = pytorch_shards[0]
            self.total_shards = pytorch_shards[1]
            self.is_sharded = True
            logger.info(f"✓ Detected {self.total_shards} pytorch shards")
            return
        
        # Check for index file (shards.json or model.safetensors.index.json)
        index_files = [
            self.parent_dir / 'model.safetensors.index.json',
            self.parent_dir / 'pytorch_model.bin.index.json',
            self.parent_dir / 'shards.json'
        ]
        
        for index_file in index_files:
            if index_file.exists():
                try:
                    with open(index_file, 'r') as f:
                        index_data = json.load(f)
                    
                    if 'weight_map' in index_data:
                        # Extract unique weight files
                        weight_files = set(index_data['weight_map'].values())
                        self.shards = {i: self.parent_dir / f for i, f in enumerate(sorted(weight_files), 1)}
                        self.total_shards = len(self.shards)
                        self.index_file = index_file
                        self.is_sharded = True
                        
                        # Detect format from extension
                        first_shard = str(list(self.shards.values())[0])
                        if first_shard.endswith('.safetensors'):
                            self.shard_format = 'safetensors'
                        elif first_shard.endswith('.bin'):
                            self.shard_format = 'pytorch'
                        
                        logger.info(f"✓ Detected shards via index file: {self.total_shards} shards ({self.shard_format})")
                        return
                except (json.JSONDecodeError, KeyError, ValueError) as e:
                    logger.warning(f"Could not parse index file {index_file}: {e}")
        
        # Check for single model files
        if self.model_path.is_file():
            self.is_sharded = False
            logger.info(f"✓ Single model file detected: {self.model_path.name}")
    
    def _find_shard_files(self, directory: Path, pattern: str) -> Optional[Tuple[Dict[int, Path], int]]:
        """Find shard files matching pattern: model-XXXX-of-YYYY.ext"""
        if not directory.exists():
            return None
        
        shard_dict = {}
        max_shard = 0
        
        for file in directory.iterdir():
            match = re.match(pattern, file.name)
            if match:
                shard_num = int(match.group(1))
                total = int(match.group(2))
                shard_dict[shard_num] = file
                max_shard = max(max_shard, total)
        
        if shard_dict and len(shard_dict) == max_shard:
            return shard_dict, max_shard
        
        return None
    
    def get_shard_info(self) -> Dict:
        """Return shard information"""
        return {
            'is_sharded': self.is_sharded,
            'total_shards': self.total_shards,
            'format': self.shard_format,
            'shards': {i: str(path) for i, path in self.shards.items()},
            'index_file': str(self.index_file) if self.index_file else None
        }


class ShardedModelConverter:
    """Convert sharded models to unified format"""
    
    def __init__(self, model_path: str):
        self.model_info = ShardedModelInfo(model_path)
        self.merged_state_dict = None
    
    def load_shards(self) -> Dict:
        """Load all shards into unified state dict"""
        if not self.model_info.is_sharded:
            logger.info("Model is not sharded, loading single file...")
            return self._load_single_model()
        
        logger.info(f"Loading {self.model_info.total_shards} shards ({self.model_info.shard_format} format)...")
        
        self.merged_state_dict = {}
        
        for shard_idx in sorted(self.model_info.shards.keys()):
            shard_path = self.model_info.shards[shard_idx]
            logger.info(f"  [{shard_idx}/{self.model_info.total_shards}] Loading {shard_path.name}...")
            
            try:
                if self.model_info.shard_format == 'safetensors':
                    if not SAFETENSORS_AVAILABLE:
                        raise ImportError("safetensors not available")
                    shard_data = load_safetensors(str(shard_path))
                
                elif self.model_info.shard_format == 'pytorch':
                    if not TORCH_AVAILABLE:
                        raise ImportError("torch not available")
                    shard_data = torch.load(str(shard_path), map_location='cpu', weights_only=True)
                
                else:
                    raise ValueError(f"Unsupported shard format: {self.model_info.shard_format}")
                
                # Merge into state dict
                self.merged_state_dict.update(shard_data)
                logger.info(f"  ✓ Loaded {len(shard_data)} parameters")
                
            except Exception as e:
                logger.error(f"  ✗ Failed to load shard {shard_idx}: {e}")
                raise
        
        logger.info(f"✓ Successfully merged {self.model_info.total_shards} shards ({len(self.merged_state_dict)} parameters)")
        return self.merged_state_dict
    
    def _load_single_model(self) -> Dict:
        """Load a single non-sharded model file"""
        try:
            if str(self.model_info.model_path).endswith('.safetensors'):
                if not SAFETENSORS_AVAILABLE:
                    raise ImportError("safetensors not available")
                return load_safetensors(str(self.model_info.model_path))
            
            elif str(self.model_info.model_path).endswith(('.bin', '.pt')):
                if not TORCH_AVAILABLE:
                    raise ImportError("torch not available")
                return torch.load(str(self.model_info.model_path), map_location='cpu', weights_only=True)
            
            else:
                raise ValueError(f"Unsupported file format: {self.model_info.model_path}")
        
        except Exception as e:
            logger.error(f"Failed to load model: {e}")
            raise
    
    def get_memory_estimate(self) -> Tuple[float, str]:
        """Estimate memory needed to load all shards"""
        total_size = 0
        
        for shard_path in self.model_info.shards.values():
            if shard_path.exists():
                total_size += shard_path.stat().st_size
        
        # Convert bytes to GB, assume 3-4x memory overhead for PyTorch
        size_gb = (total_size * 4) / (1024**3)
        
        return size_gb, f"{size_gb:.2f} GB (estimate with 4x PyTorch overhead)"


def detect_model_type(model_path: str) -> Dict:
    """
    Detect if model is sharded and return metadata
    
    Args:
        model_path: Path to model file or directory
    
    Returns:
        Dictionary with model information
    """
    try:
        info = ShardedModelInfo(model_path)
        shard_info = info.get_shard_info()
        
        mem_estimate, mem_str = ShardedModelConverter(model_path).get_memory_estimate()
        shard_info['memory_estimate_gb'] = mem_estimate
        shard_info['memory_estimate_str'] = mem_str
        
        return {
            'status': 'success',
            'model_path': model_path,
            'model_info': shard_info
        }
    
    except Exception as e:
        logger.error(f"Error detecting model: {e}")
        return {
            'status': 'error',
            'model_path': model_path,
            'error': str(e)
        }


if __name__ == '__main__':
    import argparse
    
    parser = argparse.ArgumentParser(description='Detect and analyze sharded models')
    parser.add_argument('model_path', help='Path to model file or directory')
    parser.add_argument('--load', action='store_true', help='Load and merge shards (requires torch/safetensors)')
    parser.add_argument('--info', action='store_true', help='Show detailed info')
    
    args = parser.parse_args()
    
    result = detect_model_type(args.model_path)
    
    if result['status'] == 'success':
        info = result['model_info']
        print(f"\n✓ Model Detection Result:")
        print(f"  Path: {result['model_path']}")
        print(f"  Sharded: {info['is_sharded']}")
        print(f"  Format: {info['format']}")
        print(f"  Total Shards: {info['total_shards']}")
        print(f"  Memory Estimate: {result['memory_estimate_str']}")
        
        if args.info:
            print(f"  Shards: {info['shards']}")
            if info['index_file']:
                print(f"  Index File: {info['index_file']}")
        
        if args.load and info['is_sharded']:
            print(f"\n⏳ Loading shards...")
            converter = ShardedModelConverter(args.model_path)
            state_dict = converter.load_shards()
            print(f"✓ Successfully loaded {len(state_dict)} parameters")
    
    else:
        print(f"\n✗ Error: {result['error']}")
        exit(1)
