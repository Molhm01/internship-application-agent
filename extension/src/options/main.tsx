import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import '../styles/base.css';
import './options.css';

import { trace } from '../utils/trace.js';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Options root element is missing from options.html');
}

trace('options', 'page mounted');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
