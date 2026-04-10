import React from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import GamePage from './pages/GamePage';
import ProfilePage from './pages/ProfilePage';

function App() {
  return (
    <HashRouter>
      <div className="bg-[#121214] min-h-screen text-white">
        <Routes>
          <Route path="/" element={<GamePage />} />
          <Route path="/profile" element={<ProfilePage />} />
        </Routes>
      </div>
    </HashRouter>
  );
}

export default App;
