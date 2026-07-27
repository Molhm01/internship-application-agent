import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import '../styles/base.css';
import './popup.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Popup root element is missing from popup.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
