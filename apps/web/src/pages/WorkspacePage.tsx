import { useEffect, useState } from 'react';
import type { FileListItem } from '@gmind/shared';
import { api } from '../api/client';

export function WorkspacePage() {
  const [files, setFiles] = useState<FileListItem[]>([]);
  const [error, setError] = useState('');

  async function reload() {
    try {
      setFiles(await api<FileListItem[]>('/files'));
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function createFile() {
    await api('/files', { method: 'POST', body: {} });
    await reload();
  }

  return (
    <div className="workspace">
      <header>
        <h2>我的文件</h2>
        <button onClick={() => void createFile()}>新建脑图</button>
      </header>
      {error && <p className="error">{error}</p>}
      <ul className="file-list">
        {files.map((f) => (
          <li key={f.id}>
            <span className="title">{f.title}</span>
            <span className="meta">{f.nodeCount} 节点 · 更新于 {new Date(f.updatedAt).toLocaleString()}</span>
          </li>
        ))}
        {files.length === 0 && <li className="empty">暂无文件，点击「新建脑图」开始</li>}
      </ul>
    </div>
  );
}
