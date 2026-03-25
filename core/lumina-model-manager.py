#!/usr/bin/env python3
# ==============================================================================
# LUMINA EDGE :: Model Manager (Cross-Platform)
# Download, list, and manage GGUF models from HuggingFace
# Supports: Linux, Windows, macOS
# ==============================================================================

import os
import sys
import json
import urllib.request
import urllib.error
import platform
from pathlib import Path
from typing import List, Optional

class Colors:
    """ANSI color codes"""
    GREEN = '\033[0;32m'
    YELLOW = '\033[1;33m'
    CYAN = '\033[0;36m'
    RED = '\033[0;31m'
    GRAY = '\033[0;90m'
    BOLD = '\033[1m'
    NC = '\033[0m'

class ModelManager:
    def __init__(self):
        # Detect project root
        script_dir = Path(__file__).parent
        self.root = script_dir.parent
        self.models_dir = self.root / 'models'
        self.config_file = self.root / 'config.json'
        
        # Ensure models directory exists
        self.models_dir.mkdir(parents=True, exist_ok=True)
        
        # Popular models from HuggingFace
        self.popular_models = [
            {
                'name': 'Llama 2 7B (Q4)',
                'repo': 'TheBloke/Llama-2-7B-Chat-GGUF',
                'file': 'llama-2-7b-chat.Q4_K_M.gguf'
            },
            {
                'name': 'Mistral 7B (Q4)',
                'repo': 'TheBloke/Mistral-7B-Instruct-v0.1-GGUF',
                'file': 'mistral-7b-instruct-v0.1.Q4_K_M.gguf'
            },
            {
                'name': 'Phi 2 (Q4)',
                'repo': 'TheBloke/phi-2-GGUF',
                'file': 'phi-2.Q4_K_M.gguf'
            },
            {
                'name': 'Neural Chat 7B (Q4)',
                'repo': 'TheBloke/neural-chat-7B-v3-1-GGUF',
                'file': 'neural-chat-7b-v3-1.Q4_K_M.gguf'
            },
            {
                'name': 'Orca Mini 3B (Q4)',
                'repo': 'TheBloke/orca_mini_v3_7B-GGUF',
                'file': 'orca-mini-3b.Q4_K_M.gguf'
            },
            {
                'name': 'Zephyr 7B (Q4)',
                'repo': 'TheBloke/zephyr-7B-beta-GGUF',
                'file': 'zephyr-7b-beta.Q4_K_M.gguf'
            }
        ]
    
    def log_info(self, msg: str):
        """Info message"""
        print(f"{Colors.CYAN}ℹ{Colors.NC} {msg}")
    
    def log_success(self, msg: str):
        """Success message"""
        print(f"{Colors.GREEN}✓{Colors.NC} {msg}")
    
    def log_warn(self, msg: str):
        """Warning message"""
        print(f"{Colors.YELLOW}⚠{Colors.NC} {msg}")
    
    def log_error(self, msg: str):
        """Error message"""
        print(f"{Colors.RED}✗{Colors.NC} {msg}")
    
    def print_banner(self):
        """Print banner"""
        print(f"\n{Colors.BOLD}{Colors.CYAN}⚡ LUMINA EDGE{Colors.NC} {Colors.GRAY}|{Colors.NC} Model Manager\n")
    
    def get_models(self) -> List[Path]:
        """Get list of existing models"""
        models = []
        for ext in ['*.gguf', '*.safetensors', '*.bin', '*.pt']:
            models.extend(self.models_dir.glob(ext))
        return sorted(models)
    
    def get_human_size(self, size_bytes: int) -> str:
        """Convert bytes to human-readable format"""
        for unit in ['B', 'KB', 'MB', 'GB']:
            if size_bytes < 1024:
                return f"{size_bytes:.1f} {unit}"
            size_bytes /= 1024
        return f"{size_bytes:.1f} TB"
    
    def download_file(self, url: str, dest_path: Path) -> bool:
        """Download file with progress"""
        try:
            self.log_info(f"Downloading: {url}")
            
            def download_progress(block_num, block_size, total_size):
                downloaded = block_num * block_size
                percent = min(downloaded * 100 // total_size, 100)
                bar_length = 40
                filled = int(bar_length * downloaded // total_size)
                bar = '█' * filled + '░' * (bar_length - filled)
                sys.stdout.write(f'\r[{bar}] {percent}%')
                sys.stdout.flush()
            
            urllib.request.urlretrieve(url, dest_path, download_progress)
            print()  # New line after progress
            return True
        except Exception as e:
            self.log_error(f"Download failed: {e}")
            return False
    
    def list_models_menu(self):
        """Display existing models"""
        self.print_banner()
        print(f"{Colors.GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{Colors.NC}\n")
        print(f"{Colors.BOLD}Your Models{Colors.NC}\n")
        
        models = self.get_models()
        if not models:
            self.log_warn("No models found")
            print(f"\nGet started by downloading a model below.\n")
            return
        
        for i, model_path in enumerate(models, 1):
            size = self.get_human_size(model_path.stat().st_size)
            print(f"  {Colors.BOLD}{i}{Colors.NC}. {Colors.GREEN}{model_path.name}{Colors.NC}")
            print(f"      {Colors.GRAY}Size: {size}{Colors.NC}\n")
    
    def download_model_menu(self):
        """Display download options"""
        self.print_banner()
        print(f"{Colors.GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{Colors.NC}\n")
        print(f"{Colors.BOLD}Download Models{Colors.NC}\n")
        
        for i, model in enumerate(self.popular_models, 1):
            print(f"  {Colors.BOLD}{i}{Colors.NC}. {model['name']}")
            print(f"      {Colors.GRAY}{model['repo']}{Colors.NC}\n")
        
        print(f"  {Colors.BOLD}C{Colors.NC}. Custom HuggingFace repo")
        print(f"  {Colors.BOLD}0{Colors.NC}. Back\n")
        
        choice = input(f"{Colors.CYAN}lumina@edge>{Colors.NC} ").strip()
        
        if choice == '0':
            return
        elif choice.upper() == 'C':
            self.custom_download_menu()
        elif choice.isdigit() and 1 <= int(choice) <= len(self.popular_models):
            model = self.popular_models[int(choice) - 1]
            self.download_hf_model(model['repo'], model['file'])
        else:
            self.log_error("Invalid selection")
    
    def custom_download_menu(self):
        """Download from custom HuggingFace repo"""
        print()
        repo = input(f"{Colors.CYAN}Enter HuggingFace repo (e.g., TheBloke/model-GGUF): {Colors.NC}").strip()
        
        if not repo:
            self.log_error("Repository required")
            return
        
        print()
        filename = input(f"{Colors.CYAN}Enter model filename (e.g., model.Q4_K_M.gguf): {Colors.NC}").strip()
        
        if not filename:
            self.log_error("Filename required")
            return
        
        self.download_hf_model(repo, filename)
    
    def download_hf_model(self, repo: str, filename: str):
        """Download model from HuggingFace"""
        url = f"https://huggingface.co/{repo}/resolve/main/{filename}"
        dest_path = self.models_dir / filename
        
        if dest_path.exists():
            self.log_warn(f"Model already exists: {filename}")
            overwrite = input(f"{Colors.CYAN}Overwrite? (y/n): {Colors.NC}").strip().lower()
            if overwrite != 'y':
                return
        
        print()
        if self.download_file(url, dest_path):
            self.log_success(f"Downloaded: {filename}")
            print(f"\n{Colors.GRAY}Models can now be used with Lumina Edge!{Colors.NC}\n")
        else:
            if dest_path.exists():
                dest_path.unlink()
            self.log_error("Download failed")
    
    def delete_model_menu(self):
        """Delete a model"""
        self.print_banner()
        print(f"{Colors.GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{Colors.NC}\n")
        print(f"{Colors.BOLD}Delete Model{Colors.NC}\n")
        
        models = self.get_models()
        if not models:
            self.log_warn("No models to delete")
            return
        
        for i, model_path in enumerate(models, 1):
            size = self.get_human_size(model_path.stat().st_size)
            print(f"  {Colors.BOLD}{i}{Colors.NC}. {model_path.name} ({size})\n")
        
        print(f"  {Colors.BOLD}0{Colors.NC}. Cancel\n")
        choice = input(f"{Colors.CYAN}lumina@edge>{Colors.NC} ").strip()
        
        if choice == '0':
            return
        elif choice.isdigit() and 1 <= int(choice) <= len(models):
            model_to_delete = models[int(choice) - 1]
            confirm = input(f"{Colors.YELLOW}Delete {model_to_delete.name}? (y/n): {Colors.NC}").strip().lower()
            if confirm == 'y':
                model_to_delete.unlink()
                self.log_success(f"Deleted: {model_to_delete.name}")
        else:
            self.log_error("Invalid selection")
    
    def main_menu(self):
        """Main menu loop"""
        while True:
            self.print_banner()
            print(f"{Colors.GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{Colors.NC}\n")
            
            models = self.get_models()
            print(f"{Colors.BOLD}Models{Colors.NC} ({len(models)} available)\n")
            print(f"  {Colors.BOLD}L{Colors.NC}. List models")
            print(f"  {Colors.BOLD}D{Colors.NC}. Download model")
            print(f"  {Colors.BOLD}R{Colors.NC}. Delete model")
            print(f"  {Colors.BOLD}0{Colors.NC}. Exit\n")
            
            choice = input(f"{Colors.CYAN}lumina@edge>{Colors.NC} ").strip().upper()
            
            if choice == '0':
                print()
                break
            elif choice == 'L':
                self.list_models_menu()
                input(f"{Colors.GRAY}Press Enter to continue...{Colors.NC}")
            elif choice == 'D':
                self.download_model_menu()
                input(f"{Colors.GRAY}Press Enter to continue...{Colors.NC}")
            elif choice == 'R':
                self.delete_model_menu()
                input(f"{Colors.GRAY}Press Enter to continue...{Colors.NC}")
            else:
                self.log_error("Invalid selection")

def main():
    """Main entry point"""
    # Clear screen (cross-platform)
    os.system('cls' if os.name == 'nt' else 'clear')
    
    manager = ModelManager()
    try:
        manager.main_menu()
    except KeyboardInterrupt:
        print(f"\n{Colors.YELLOW}Interrupted by user{Colors.NC}")
        sys.exit(0)
    except Exception as e:
        print(f"{Colors.RED}Error: {e}{Colors.NC}")
        sys.exit(1)

if __name__ == '__main__':
    main()
