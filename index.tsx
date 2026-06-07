
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { Project } from './types';
import './index.css';
import { decompressText } from './utils';

const urlParams = new URLSearchParams(window.location.search);
const loadedProjectFromURL = urlParams.get("import");
const projectLoadQueue: Project[] = [];

if (loadedProjectFromURL) {
  projectLoadQueue.push(JSON.parse(decompressText(loadedProjectFromURL)) as Project);
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);

root.render(
  <React.StrictMode>
    <App projectLoadQueue={projectLoadQueue} />
  </React.StrictMode>
);