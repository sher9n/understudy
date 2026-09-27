import React from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import './shell.css';
import './learn.css';
import App from './App.jsx';
// the website's look for every screen: last, so it is read after every other sheet
import './one-look.css';

createRoot(document.getElementById('root')).render(<App />);
