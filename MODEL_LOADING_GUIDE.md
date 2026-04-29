# Quick Start: Model Loading on macOS Apple Silicon

## ✅ What Works

Your Lumina Edge setup is fully functional:
- ✓ Model files are complete (628MB safetensors)
- ✓ MLX-LM framework is installed
- ✓ Model loading works correctly
- ✓ API server launches successfully

## 🚀 How to Test Model Loading

### Option 1: Run Automated Tests
```bash
cd /Users/parthsrivastava/Developer/2026-Lumina-Edge-LLM-Inference-Framework
bash test_model_load.sh
```

### Option 2: Launch Lumina Edge Normally
```bash
cd ui
npm run start
```

The app will automatically:
1. Start the API server on port 1235
2. Launch the Vite dev server
3. Open Electron window with the UI

Then go to **Models** tab and click **Load** on your model.

## 🔧 Troubleshooting

### "No model loaded" error appears

1. **Check if API server is running:**
   ```bash
   curl http://127.0.0.1:1235/api/health
   ```
   Should return: `{"status":"ok",...}`

2. **Check if model can be loaded directly:**
   ```bash
   source venv/bin/activate
   python3 -c "import mlx_lm; mlx_lm.load('models/LFM2.5-1.2B-Instruct-MLX-4bit'); print('OK')"
   ```

3. **Check Electron console for errors:**
   - Press `Cmd + Alt + I` to open dev tools
   - Check console tab for API server logs

### Slow model loading

- First load will be slow (~30-60 seconds) as MLX compiles the model for Metal
- Subsequent loads will be much faster
- This is normal for M-series Macs on first load

### Memory Issues

The LFM2.5 model uses ~2-3GB of unified memory. On M5 MacBook:
- With 16GB+ RAM: Should work smoothly
- With 8GB RAM: May be slower due to swap
- Monitor Activity Monitor > Memory tab while loading

## 📊 System Info

Your system:
- **OS:** macOS (Apple Silicon)
- **Model:** LFM2.5-1.2B-Instruct-MLX-4bit (1.2B parameters)
- **Model Size:** 628 MB
- **Framework:** MLX-LM (optimized for Apple Silicon)
- **API:** OpenAI-compatible REST API
- **Port:** 1235

## ✨ Recent Fixes

The following issues were fixed in commit [3de1fa7]:

1. **Added API server error logging** - Now you can see what's happening
2. **Updated MLX backend to modern format** - No more deprecation warnings
3. **Improved error handling** - Better error messages when things go wrong

## 📝 Files to Know About

- `ui/api-server.js` - Node.js API gateway (port 1235)
- `scripts/mlx_backend.py` - Python MLX backend (handles model loading)
- `models/LFM2.5-1.2B-Instruct-MLX-4bit/` - Your model files
- `test_model_load.sh` - Test script to verify everything works
- `FIXES.md` - Detailed fix documentation

## Need Help?

1. Run `bash test_model_load.sh` first - this tests all components
2. Check `FIXES.md` for detailed technical information
3. Look at `Cmd+Alt+I` console output in Electron for specific errors
4. Check `/tmp/lumina_model_*.log` files if you started a server manually

---

**Status:** ✅ All systems operational. Model loading is working correctly.
