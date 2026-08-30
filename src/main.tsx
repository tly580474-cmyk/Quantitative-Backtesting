import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import './components/mobile/mobile-layout.css';
import { applyColorMode, readColorMode } from './theme';

applyColorMode(readColorMode());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
