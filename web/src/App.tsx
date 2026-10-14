import { Navigate, Route, Routes } from 'react-router';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/maps" replace />} />
      <Route path="/maps" element={<p>Maps</p>} />
      <Route path="/viewer/:id" element={<p>Viewer</p>} />
      <Route path="/map/:id" element={<p>Public map</p>} />
    </Routes>
  );
}
