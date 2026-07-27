import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import '../styles/base.css';
import './fill-plan.css';

const root = document.getElementById('root');
if (!root) throw new Error('Fill plan root element is missing.');
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
