import { useState, type MouseEvent, type ReactElement } from 'react';

/**
 * 评论面板（M3b Task 7，FR-CMT-002）。
 *
 * 装配裁决：右列 RichPanel 下方的独立面板区（data-testid="comment-panel"，常驻——
 * 进入文档即随 GET /comments 全量数据可见）。纯展示组件：POST/定位/过滤回调由
 * EditorPage 提供（刷新收敛与选区装配集中在页面侧）。
 *
 * 结构：
 * - 顶部评论输入：占位「选中节点添加评论」，仅在画布恰好单选一个节点时可用
 *   （选中节点经 props.selectedNodeId 传入，EditorPage 以 primaryId 同源口径判定）；
 * - 线程列表：楼主时间倒序（服务端已排序），每线程含作者/内容/楼中楼（升序缩进）
 *   与回复输入；条目点击 → onLocate 定位画布节点（输入控件不冒泡）；
 * - 节点筛选：角标点击进入单节点筛选视图，头部「查看全部」返回；
 * - 节点解耦（FR-CMT-002 验收）：nodeDeleted 线程显示「原节点已删除」徽标，
 *   快照与全文原样保留。
 */

/** 评论视图（与 server CommentsService CommentView 同形，web 侧独立声明）。 */
export interface CommentView {
  id: string;
  fileId: string;
  nodeId: string;
  nodeTextSnapshot: string;
  nodeDeleted: boolean;
  author: { id: string; nickname: string };
  content: string;
  mentions: string[];
  createdAt: string;
}

/** 线程视图：楼主 + 楼中楼（升序）。 */
export interface CommentThreadView extends CommentView {
  replies: CommentView[];
}

export interface CommentPanelProps {
  threads: CommentThreadView[];
  /** 单节点筛选（角标点击入口）：null = 全部线程。 */
  filterNodeId: string | null;
  /** 当前画布单选节点（评论输入的落点；null 时输入禁用）。 */
  selectedNodeId: string | null;
  onClearFilter(): void;
  /** 面板条目点击 → 画布定位（selectOnly + 展开折叠祖先，EditorPage 装配）。 */
  onLocate(nodeId: string): void;
  onAddComment(content: string): void;
  onReply(threadId: string, content: string): void;
}

/** 交互元素命中守卫：条目点击定位时让路给回复输入/按钮。 */
function withinInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('input,button,textarea,label') !== null;
}

function ReplyBox({ onReply }: { onReply(content: string): void }) {
  const [value, setValue] = useState('');
  const send = (): void => {
    const text = value.trim();
    if (text === '') return;
    onReply(text);
    setValue('');
  };
  return (
    <div className="comment-reply-box">
      <input
        data-testid="reply-input"
        aria-label="回复评论"
        placeholder="回复…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.stopPropagation();
            send();
          }
        }}
      />
      <button type="button" data-testid="reply-send" onClick={send}>
        回复
      </button>
    </div>
  );
}

function ThreadItem({
  thread,
  onLocate,
  onReply,
}: {
  thread: CommentThreadView;
  onLocate(nodeId: string): void;
  onReply(threadId: string, content: string): void;
}) {
  const locate = (e: MouseEvent<HTMLElement>): void => {
    if (withinInteractive(e.target)) return; // 回复输入/按钮点击不触发定位
    onLocate(thread.nodeId);
  };
  return (
    <article
      className="comment-thread"
      data-testid="comment-thread"
      data-node-id={thread.nodeId}
      onClick={locate}
    >
      <header className="comment-thread-head">
        <span className="comment-node" data-testid="comment-node-snap">
          {thread.nodeTextSnapshot}
        </span>
        {thread.nodeDeleted && (
          <span className="comment-node-deleted" data-testid="comment-node-deleted">
            原节点已删除
          </span>
        )}
      </header>
      <div className="comment-main">
        <span className="comment-author" data-testid="comment-author">
          {thread.author.nickname}
        </span>
        <span className="comment-content" data-testid="comment-content">
          {thread.content}
        </span>
      </div>
      {thread.replies.length > 0 && (
        <ul className="comment-replies" data-testid="comment-replies">
          {thread.replies.map((r) => (
            <li key={r.id} className="comment-reply" data-testid="comment-reply">
              <span className="comment-author">{r.author.nickname}</span>
              <span className="comment-content">{r.content}</span>
            </li>
          ))}
        </ul>
      )}
      <ReplyBox onReply={(content) => onReply(thread.id, content)} />
    </article>
  );
}

export function CommentPanel(props: CommentPanelProps): ReactElement {
  const { threads, filterNodeId, selectedNodeId, onClearFilter, onLocate, onAddComment, onReply } =
    props;
  const [draft, setDraft] = useState('');
  const visible = filterNodeId === null ? threads : threads.filter((t) => t.nodeId === filterNodeId);
  const send = (): void => {
    const text = draft.trim();
    if (text === '' || selectedNodeId === null) return;
    onAddComment(text);
    setDraft('');
  };
  return (
    <section className="comment-panel" data-testid="comment-panel" aria-label="评论">
      <div className="comment-panel-head">
        <h3>评论</h3>
        {filterNodeId !== null && (
          <button type="button" data-testid="comment-back-all" onClick={onClearFilter}>
            查看全部
          </button>
        )}
      </div>
      <div className="comment-composer">
        <input
          data-testid="comment-input"
          aria-label="添加评论"
          placeholder="选中节点添加评论"
          value={draft}
          disabled={selectedNodeId === null}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
          }}
        />
        <button
          type="button"
          data-testid="comment-send"
          disabled={selectedNodeId === null || draft.trim() === ''}
          onClick={send}
        >
          发送
        </button>
      </div>
      {visible.length === 0 ? (
        <p className="comment-empty">暂无评论</p>
      ) : (
        <ul className="comment-threads">
          {visible.map((t) => (
            <li key={t.id}>
              <ThreadItem thread={t} onLocate={onLocate} onReply={onReply} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
