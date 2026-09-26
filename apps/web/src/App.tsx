import { useEffect, type ReactElement } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { getToken } from './api/client';
import { connectNotifications } from './notify';
import { LoginPage } from './pages/LoginPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { TrashPage } from './pages/TrashPage';
import { SettingsPage } from './pages/SettingsPage';
import { EditorPage } from './pages/EditorPage';
import { ShareLandingPage } from './pages/ShareLandingPage';

function RequireAuth({ children }: { children: ReactElement }) {
  return getToken() ? children : <Navigate to="/login" replace />;
}

export function App() {
  const location = useLocation();
  // 站内通知 SSE（M3b Task 8，FR-CMT-005）：每次路由挂载/切换尝试建连（幂等 no-op：
  // 未登录或已连接直接跳过）——登录后的首次导航即建立连接，此后全应用仅此一条长连接；
  // 断线后由下一次导航重建（连接策略详见 notify.ts）。
  useEffect(() => {
    connectNotifications();
  }, [location]);

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
      {/* 账号设置（M5 Task 1，FR-ACC-002 收口 + FR-CMT-006 通知偏好收口） */}
      <Route
        path="/settings"
        element={
          <RequireAuth>
            <SettingsPage />
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
