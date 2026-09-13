import { createElement } from 'react';
import App from 'C:/Users/mohiuddin/OneDrive/Desktop/dropkerb/spikes/s1-debug-internals/fixtures/react/src/App.jsx';
import ReactPkg from 'react';
window.__SPIKE_REACT_VERSION = "18.3.1";
window.__SPIKE_REACT_RUNTIME = (ReactPkg && ReactPkg.version) || null;
import { createRoot } from 'react-dom/client';
createRoot(document.getElementById('root')).render(createElement(App));
