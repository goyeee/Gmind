/**
 * 演示数据播种（2026-11-12 账号邮箱化重做）：走真实注册/登录 API 造号。
 * - 超管：demo@gmind.dev（昵称「演示管理员」）；同事：陈默(研发)/周舟(测试)/
 *   许然(设计)/孙宁(研发)——邮箱 chenmo/zhouzhou/xuran/sunning@gmind.dev；
 * - 密码统一 demo123456；注册走 email-code（dev 固定码 123456）→ register 真实 API，
 *   注册即登录拿 token；已注册（409）回落邮箱+密码登录（幂等重跑）；
 * - 超管角色不在此设置：清库后首个注册号自动 super_admin（users.service.createByEmail
 *   空库判定）。库非空时 demo 会是 member——脚本开头探测并警告，部门/分组/挂靠
 *   （admin 口，AdminGuard）将 403 失败；
 * - 部门：产品部/研发部/测试部/设计部；分组：项目核心组/前端组/测试组/体验小组；
 * - 账号挂靠部门+分组；演示管理员=产品部+项目核心组；
 * - 8 个文件（脑图+表格混合，原型同款标题），节点任务覆盖：今日到期/已逾期/7 天内/
 *   无截止/已完成，负责人分散给超管与同事；部分文件加同事为协作者（协作空间/
 *   与我共享有数据）；星标若干。
 * 幂等：邮箱已注册回落登录；已存在的标题文件跳过。昵称在注册时随单携带，重跑若
 * 有漂移由 PATCH /api/users/me 自助改回（该端点 2026-11-12 账号重做才新增，旧脚本
 * 调用时此接口尚不存在、恒静默失败）。跑法：`pnpm --filter @gmind/server exec tsx
 * scripts/seed-demo.ts`（需 dev server :3001，API_ORIGIN 可覆盖；空库首跑 demo 即超管）。
 */
import { createTemplateDoc, docToState, getNode, setNodeTask, setText } from '@gmind/core';

const BASE = process.env.API_ORIGIN ?? 'http://localhost:3001';
/** dev/test 固定邮箱验证码（EmailCodeService 裁定，不发真实邮件）。 */
const DEV_MAIL_CODE = '123456';
/** 演示账号统一密码（含超管，admin-users e2e ADMIN_PASSWORD 同值）。 */
const DEMO_PASSWORD = 'demo123456';

interface Ctx {
  token: string;
  userId: string;
}

async function req(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let bodyOut: unknown = null;
  try {
    bodyOut = text === '' ? null : JSON.parse(text);
  } catch {
    bodyOut = text;
  }
  return { status: res.status, body: bodyOut };
}

/** 造号：发码→注册（注册即登录）；邮箱已注册（发码/注册 409）回落密码登录。
 *  重跑不触发发码 60s 冷却——发码端点的已注册 409 判定在冷却占位之前。 */
async function registerOrLogin(email: string, nickname: string): Promise<Ctx> {
  const code = await req('POST', '/api/auth/email-code', null, { scene: 'register', email });
  if (code.status === 204) {
    const reg = await req('POST', '/api/auth/register', null, {
      email,
      code: DEV_MAIL_CODE,
      password: DEMO_PASSWORD,
      nickname,
    });
    if (reg.status === 200) {
      const body = reg.body as { token: string; user: { id: string } };
      return { token: body.token, userId: body.user.id };
    }
    if (reg.status !== 409) throw new Error(`注册失败 ${email}: ${reg.status} ${JSON.stringify(reg.body)}`);
  } else if (code.status !== 409) {
    throw new Error(`发码失败 ${email}: ${code.status} ${JSON.stringify(code.body)}`);
  }
  const login = await req('POST', '/api/auth/login', null, { account: email, password: DEMO_PASSWORD });
  if (login.status !== 200) throw new Error(`登录失败 ${email}: ${login.status} ${JSON.stringify(login.body)}`);
  const body = login.body as { token: string; user: { id: string } };
  return { token: body.token, userId: body.user.id };
}

/** 昵称保真（幂等）：已是目标昵称不写；否则 PATCH /api/users/me 自助改昵称。 */
async function ensureNickname(ctx: Ctx, nickname: string): Promise<void> {
  const meRes = await req('GET', '/api/users/me', ctx.token);
  if ((meRes.body as { nickname?: string }).nickname === nickname) return;
  const patched = await req('PATCH', '/api/users/me', ctx.token, { nickname });
  if (patched.status !== 200) throw new Error(`改昵称失败 ${nickname}: ${patched.status} ${JSON.stringify(patched.body)}`);
}

const day = (offset: number): string => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);

async function main(): Promise<void> {
  console.log('== 1. 账号 ==');
  const SUPER_ADMIN = { email: 'demo@gmind.dev', nickname: '演示管理员' };
  const me = await registerOrLogin(SUPER_ADMIN.email, SUPER_ADMIN.nickname);
  await ensureNickname(me, SUPER_ADMIN.nickname);
  console.log('超管：', SUPER_ADMIN.nickname, SUPER_ADMIN.email, me.userId);
  // 超管闸（admin 口端点依赖）：空库首注册才是 super_admin；库非空时提示 403 风险
  const meView = (await req('GET', '/api/users/me', me.token)).body as { systemRole?: string };
  if (meView.systemRole !== 'super_admin') {
    console.warn(
      `[seed] 警告：${SUPER_ADMIN.email} 当前 systemRole=${meView.systemRole ?? '未知'}（super_admin 只授给清库后首个注册号）。` +
        '后续部门/分组/挂靠（admin 口）将 403 失败；请清库后首跑，或由管理员提权该账号。',
    );
  }
  const mates: Array<{ email: string; name: string }> = [
    { email: 'chenmo@gmind.dev', name: '陈默' },
    { email: 'zhouzhou@gmind.dev', name: '周舟' },
    { email: 'xuran@gmind.dev', name: '许然' },
    { email: 'sunning@gmind.dev', name: '孙宁' },
  ];
  const mateCtx: Ctx[] = [];
  for (const m of mates) {
    const ctx = await registerOrLogin(m.email, m.name);
    await ensureNickname(ctx, m.name);
    mateCtx.push(ctx);
    console.log('同事：', m.name, m.email, ctx.userId);
  }
  const all: Ctx[] = [me, ...mateCtx];

  console.log('== 2. 部门/分组 ==');
  const dir = (await req('GET', '/api/org/directory', me.token)).body as {
    departments: Array<{ id: string; name: string }>;
    groups: Array<{ id: string; name: string }>;
    memberships: Array<{ userId: string; departmentId: string | null; groupIds: string[] }>;
  };
  const deptId = new Map<string, string>();
  for (const name of ['产品部', '研发部', '测试部', '设计部']) {
    const exist = dir.departments.find((d) => d.name === name);
    if (exist) {
      deptId.set(name, exist.id);
      continue;
    }
    const r = await req('POST', '/api/org/departments', me.token, { name });
    if (r.status !== 201) throw new Error(`建部门失败 ${name}: ${r.status} ${JSON.stringify(r.body)}`);
    deptId.set(name, (r.body as { id: string }).id);
  }
  const groupId = new Map<string, string>();
  const GROUP_COLORS = ['#3370ff', '#00b42a', '#ff7d00', '#7c3aed'];
  const groupNames = ['项目核心组', '前端组', '测试组', '体验小组'];
  for (let i = 0; i < groupNames.length; i++) {
    const name = groupNames[i]!;
    const exist = dir.groups.find((g) => g.name === name);
    if (exist) {
      groupId.set(name, exist.id);
      continue;
    }
    const r = await req('POST', '/api/org/groups', me.token, { name, color: GROUP_COLORS[i] });
    if (r.status !== 201) throw new Error(`建分组失败 ${name}: ${r.status} ${JSON.stringify(r.body)}`);
    groupId.set(name, (r.body as { id: string }).id);
  }
  console.log('部门', [...deptId.values()], '分组', [...groupId.values()]);

  console.log('== 3. 账号挂靠 ==');
  const plan: Array<{ ctx: Ctx; dept: string; groups: string[]; nickname: string }> = [
    { ctx: me, dept: '产品部', groups: ['项目核心组'], nickname: SUPER_ADMIN.nickname },
    { ctx: mateCtx[0]!, dept: '研发部', groups: ['项目核心组', '前端组'], nickname: '陈默' },
    { ctx: mateCtx[1]!, dept: '测试部', groups: ['测试组'], nickname: '周舟' },
    { ctx: mateCtx[2]!, dept: '设计部', groups: ['体验小组'], nickname: '许然' },
    { ctx: mateCtx[3]!, dept: '研发部', groups: ['前端组'], nickname: '孙宁' },
  ];
  for (const p of plan) {
    const r = await req('PATCH', `/api/admin/users/${p.ctx.userId}`, me.token, {
      departmentId: deptId.get(p.dept) ?? null,
      groupIds: p.groups.map((g) => groupId.get(g)).filter((x): x is string => x !== undefined),
    });
    if (r.status !== 200) throw new Error(`挂靠失败 ${p.nickname}: ${r.status} ${JSON.stringify(r.body)}`);
    console.log('挂靠：', p.nickname, p.dept, p.groups.join('+'));
  }

  console.log('== 4. 文件+任务 ==');
  interface TaskSpec {
    text: string;
    desc?: string;
    ownerIdx: number; // all 数组下标
    due: number | null; // 天偏移
    status: 'todo' | 'doing' | 'done';
    progress: number;
  }
  interface FileSpec {
    title: string;
    kind: 'map' | 'table';
    starred?: boolean;
    collabWith?: number[]; // mateCtx 下标
    root: { text: string };
    children: Array<{ text: string; children: Array<TaskSpec & { text: string }> }>;
  }
  const O = { ME: 0, CHEN: 1, ZHOU: 2, XU: 3, SUN: 4 };
  const files: FileSpec[] = [
    {
      title: '会议纪要', kind: 'map', starred: true, collabWith: [O.CHEN, O.ZHOU],
      root: { text: '会议纪要' },
      children: [
        { text: '会议信息', children: [{ text: '确认时间地点参会人', ownerIdx: O.ME, due: 0, status: 'done', progress: 100 }] },
        { text: '议题讨论', children: [
          { text: '议题一：接口方案评审', desc: '接口方案评审', ownerIdx: O.CHEN, due: 0, status: 'doing', progress: 80 },
          { text: '议题二：排期与资源', desc: '排期与资源', ownerIdx: O.ME, due: 1, status: 'doing', progress: 40 },
        ] },
        { text: '结论', children: [{ text: '达成一致的结论', ownerIdx: O.ZHOU, due: 2, status: 'todo', progress: 0 }] },
        { text: '待办', children: [{ text: '整理待办清单', desc: '汇总会上所有待办并分派', ownerIdx: O.ME, due: 3, status: 'doing', progress: 23 }] },
      ],
    },
    {
      title: 'Q4 任务看板', kind: 'table', collabWith: [O.CHEN],
      root: { text: 'Q4 任务看板' },
      children: [
        { text: '需求评审', children: [{ text: '整理需求', ownerIdx: O.CHEN, due: -1, status: 'done', progress: 100 }] },
        { text: '评审会议', children: [{ text: '组织评审会', ownerIdx: O.ME, due: 0, status: 'doing', progress: 60 }] },
        { text: '开发排期', children: [{ text: '排期到人', ownerIdx: O.SUN, due: 5, status: 'todo', progress: 0 }] },
      ],
    },
    {
      title: '产品规划脑图', kind: 'map', starred: true, collabWith: [O.XU],
      root: { text: '产品规划' },
      children: [
        { text: '启动', children: [{ text: '目标对齐', ownerIdx: O.ME, due: 1, status: 'doing', progress: 70 }] },
        { text: '设计', children: [{ text: '信息架构', ownerIdx: O.XU, due: 3, status: 'doing', progress: 45 }] },
        { text: '发布', children: [{ text: '灰度发布', ownerIdx: O.CHEN, due: 6, status: 'todo', progress: 0 }] },
      ],
    },
    {
      title: '读书笔记《认知觉醒》', kind: 'map',
      root: { text: '认知觉醒' },
      children: [
        { text: '核心观点', children: [{ text: '元认知笔记', ownerIdx: O.ME, due: null, status: 'doing', progress: 50 }] },
        { text: '行动清单', children: [{ text: '每日复盘', ownerIdx: O.ME, due: null, status: 'todo', progress: 0 }] },
      ],
    },
    {
      title: 'Sprint 24 跟踪', kind: 'table', collabWith: [O.ZHOU, O.SUN],
      root: { text: 'Sprint 24' },
      children: [
        { text: '登录改版', children: [{ text: '前端开发', ownerIdx: O.SUN, due: 0, status: 'doing', progress: 65 }] },
        { text: '消息中心', children: [{ text: '联调测试', ownerIdx: O.ZHOU, due: -2, status: 'doing', progress: 30 }] },
        { text: '缺陷修复', children: [{ text: '修复崩溃', ownerIdx: O.ME, due: -1, status: 'done', progress: 100 }] },
      ],
    },
    {
      title: '团队 OKR 拆解', kind: 'map', collabWith: [O.CHEN, O.XU, O.ZHOU],
      root: { text: 'Q4 OKR' },
      children: [
        { text: 'O1 提升留存', children: [{ text: 'KR1 次月留存≥45%', ownerIdx: O.CHEN, due: 4, status: 'doing', progress: 55 }] },
        { text: 'O2 拓展企业版', children: [{ text: 'KR1 签约 20 家', ownerIdx: O.ME, due: 5, status: 'todo', progress: 10 }] },
      ],
    },
    {
      title: '周计划', kind: 'map',
      root: { text: '周计划' },
      children: [
        { text: '工作', children: [{ text: '重点：版本发布', ownerIdx: O.ME, due: 2, status: 'doing', progress: 75 }] },
        { text: '生活', children: [{ text: '每周跑步三次', ownerIdx: O.ME, due: null, status: 'todo', progress: 33 }] },
      ],
    },
    {
      title: '竞品分析', kind: 'map', collabWith: [O.XU],
      root: { text: '竞品分析' },
      children: [
        { text: '竞品 T', children: [{ text: '优势 S 分析', ownerIdx: O.XU, due: 7, status: 'doing', progress: 20 }] },
        { text: '机会 O', children: [{ text: '新市场调研', ownerIdx: O.ME, due: 8, status: 'todo', progress: 0 }] },
      ],
    },
  ];

  const existing = (await req('GET', '/api/files?view=mine', me.token)).body as Array<{ title: string; kind: string }>;
  for (const spec of files) {
    if (existing.some((f) => f.title === spec.title)) {
      console.log('跳过（已存在）：', spec.title);
      continue;
    }
    const created = await req('POST', '/api/files', me.token, { title: spec.title, kind: spec.kind });
    if (created.status !== 201) {
      console.error('创建失败：', spec.title, created.status, created.body);
      continue;
    }
    const fileId = (created.body as { id: string }).id;
    const doc = createTemplateDoc({
      title: spec.title,
      rootText: spec.root.text,
      children: spec.children.map((c) => ({ text: c.text, children: c.children.map((l) => ({ text: l.text })) })),
    });
    const branchIds = getNode(doc, 'root')!.childIds;
    spec.children.forEach((branch, bi) => {
      const leafIds = getNode(doc, branchIds[bi]!)!.childIds;
      branch.children.forEach((leaf, li) => {
        const nodeId = leafIds[li];
        if (!nodeId) return;
        const owner = all[leaf.ownerIdx]!;
        setText(doc, nodeId, leaf.text);
        const base = {
          owners: [owner.userId],
          ...(leaf.due === null ? {} : { dueDate: day(leaf.due) }),
        };
        if (leaf.status === 'done') {
          // done 闸门：进度先 100 再标完成（core TASK_DONE_GATE_BLOCKED）
          setNodeTask(doc, nodeId, { ...base, progress: 100 });
          setNodeTask(doc, nodeId, { status: 'done' });
        } else {
          setNodeTask(doc, nodeId, { ...base, status: leaf.status, progress: leaf.progress });
        }
      });
    });
    const state = Buffer.from(docToState(doc)).toString('base64');
    const put = await req('PUT', `/api/files/${fileId}/doc-state`, me.token, { docState: state });
    if (put.status !== 200) console.error('PUT 失败：', spec.title, put.status);
    for (const mi of spec.collabWith ?? []) {
      await req('POST', `/api/files/${fileId}/collaborators`, me.token, { userIds: [mateCtx[mi - 1]!.userId] });
    }
    if (spec.starred) await req('PUT', `/api/files/${fileId}/star`, me.token);
    console.log('已建：', spec.title, `(${spec.kind})`);
  }

  console.log('== 完成 ==');
}

void main();
