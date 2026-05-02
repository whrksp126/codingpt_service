// src/App.jsx

import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom'; // BrowserRouter로 직접 import
import Main from './pages/Main';
import Admin from './pages/Admin';
import Code from './pages/Code';
import Execute from './pages/Execute';

import Curriculums from './pages/Curriculums';
import Curriculum from './pages/Curriculum';
import Sections from './pages/Sections';
import TTS from './pages/TTS';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Main />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/code/:id" element={<Code />} />
        <Route path="/execute" element={<Execute />} />
        <Route path="/tts" element={<TTS />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
