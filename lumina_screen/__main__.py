"""
Lumina Screen — Resume Screening Pipeline
Run with: python3 -m lumina_screen
Or from lumina_screen/ directory: python3 main.py
"""

if __name__ == "__main__":
    from .main import main
    main()  # Delegate to main.py's orchestrator — this module is just the CLI trampoline
