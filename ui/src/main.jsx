// React entry point — mounts App into #root
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'  // Dark-theme global styles

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)
