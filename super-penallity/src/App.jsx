import React from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import GamePage from './pages/GamePage';
import ProfilePage from './pages/ProfilePage';

function App() {
  return (
    <HashRouter>
      <div className="bg-gray-900 min-h-screen text-white">
        <Routes>
          <Route path="/" element={<GamePage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="*" element={<GamePage />} />
        </Routes>
      </div>
    </HashRouter>
  );
}

export default App;
