import { Navigate, Route, Routes } from 'react-router';
import { MapsPage } from './pages/MapsPage';
import { loadPrivate, loadPublic, ViewerPage } from './pages/ViewerPage';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/maps" replace />} />
      <Route path="/maps" element={<MapsPage />} />
      <Route path="/viewer/:id" element={<ViewerPage load={loadPrivate} />} />
      <Route path="/map/:id" element={<ViewerPage load={loadPublic} />} />
    </Routes>
  );
}
