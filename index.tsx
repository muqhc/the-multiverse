
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import AppSp from './AppSp';
import { Project } from './types';

const urlParams = new URLSearchParams(window.location.search);
const loadedProjectFromURL = urlParams.get("import");
const uiMode = urlParams.get("ui");
const projectLoadQueue: Project[] = [];

if (loadedProjectFromURL) {
  projectLoadQueue.push(JSON.parse(decodeURIComponent(loadedProjectFromURL)) as Project);
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);

if (uiMode === "spreadsheet") {
  root.render(
    <React.StrictMode>
      <AppSp projectLoadQueue={projectLoadQueue} />
    </React.StrictMode>
  );
} else { //default: "rounded"
  root.render(
    <React.StrictMode>
      <App projectLoadQueue={projectLoadQueue} />
    </React.StrictMode>
  );
}