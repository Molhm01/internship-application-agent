import React from 'react';
import ReactDOM from 'react-dom/client';
import '../styles/base.css';
import './review.css';
import { App } from './App.js';

const root = document.getElementById('root');
if (!root) throw new Error('Review root element is missing.');
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
