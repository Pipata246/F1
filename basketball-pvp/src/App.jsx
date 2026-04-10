import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import GamePage from './pages/GamePage';
import ProfilePage from './pages/ProfilePage';

function App() {
  return (
    <BrowserRouter>
      <div className="bg-[#121214] min-h-screen text-white">
        <Routes>
          <Route path="/" element={<GamePage />} />
          <Route path="/profile" element={<ProfilePage />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

export default App;
