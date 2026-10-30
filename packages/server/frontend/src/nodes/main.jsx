import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installAppHeightSync } from '../app-height';
import NodesApp from './NodesApp';

installAppHeightSync();
createRoot(document.getElementById('root')).render(<StrictMode><NodesApp /></StrictMode>);
