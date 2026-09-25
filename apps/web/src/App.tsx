import type { ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { getToken } from './api/client';
import { LoginPage } from './pages/LoginPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { TrashPage } from './pages/TrashPage';
import { EditorPage } from './pages/EditorPage';
import { ShareLandingPage } from './pages/ShareLandingPage';

function RequireAuth({ children }: { children: ReactElement }) {
  return getToken() ? children : <Navigate to="/login" replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/* 分享落地页（M3b Task 4，FR-SHR-001）：公开可达，登录探测/跳转在页面内自理 */}
      <Route path="/s/:token" element={<ShareLandingPage />} />
      <Route
        path="/workspace"
        element={
          <RequireAuth>
            <WorkspacePage />
          </RequireAuth>
        }
      />
      <Route
        path="/trash"
        element={
          <RequireAuth>
            <TrashPage />
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
