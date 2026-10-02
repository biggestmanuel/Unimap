import React from 'react';
import { createRoot } from 'react-dom/client';
import AdminApp from './AdminApp.jsx';
import './admin.css';

createRoot(document.getElementById('admin-root')).render(
  <React.StrictMode>
    <AdminApp />
  </React.StrictMode>,
);