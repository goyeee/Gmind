import type { ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { getToken } from './api/client';
import { LoginPage } from './pages/LoginPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { EditorPage } from './pages/EditorPage';

function RequireAuth({ children }: { children: ReactElement }) {
  return getToken() ? children : <Navigate to="/login" replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/workspace"
        element={
          <RequireAuth>
            <WorkspacePage />
          </RequireAuth>
        }
      />
      <Route
        path="/edit/:fileId"
        element={
          <RequireAuth>
            <EditorPage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to={getToken() ? '/workspace' : '/login'} replace />} />
    </Routes>
  );
}
