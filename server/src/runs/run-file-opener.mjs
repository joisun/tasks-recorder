import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function fileError(code, message, statusCode) {
  return Object.assign(new Error(message), { code, statusCode })
}

function inside(root, target) {
  const difference = relative(root, target)
  return difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference)
}

export async function openRunFile(run, path, {
  platform = process.platform,
  execFileImpl = execFileAsync,
} = {}) {
  if (typeof path !== 'string' || !path.trim() || path.includes(String.fromCharCode(0))
    || Buffer.byteLength(path) > 4096) {
    throw fileError('RUN_FILE_PATH_INVALID', '文件路径无效', 400)
  }
  const recorded = run.file_changes?.find(file => file.path === path)
  if (!recorded) throw fileError('RUN_FILE_NOT_RECORDED', '文件不在该 Run 的产出记录中', 403)
  if (['delete', 'deleted', 'removed'].includes(recorded.kind)) {
    throw fileError('RUN_FILE_DELETED', '该文件已在此 Run 中删除，无法打开', 409)
  }
  const workspace = run.snapshot?.workspace
  if (typeof workspace !== 'string' || !isAbsolute(workspace) || workspace.includes(String.fromCharCode(0))) {
    throw fileError('RUN_FILE_WORKSPACE_INVALID', '该 Run 没有有效的 workspace', 409)
  }
  const target = resolve(workspace, path)
  if (!inside(workspace, target)) {
    throw fileError('RUN_FILE_OUTSIDE_WORKSPACE', '仅支持打开该 Run workspace 内的文件', 403)
  }
  let canonicalTarget
  let metadata
  try {
    const canonicalWorkspace = await realpath(workspace)
    canonicalTarget = await realpath(target)
    if (!inside(canonicalWorkspace, canonicalTarget)) {
      throw fileError('RUN_FILE_OUTSIDE_WORKSPACE', '文件链接指向该 Run workspace 之外', 403)
    }
    metadata = await stat(canonicalTarget)
  } catch (error) {
    if (error.code?.startsWith('RUN_FILE_')) throw error
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) {
      throw fileError('RUN_FILE_NOT_FOUND', '文件或该 Run 的 workspace 已不存在', 404)
    }
    throw fileError('RUN_FILE_UNREADABLE', '无法访问该文件，请检查文件权限', 403)
  }
  if (!metadata.isFile()) throw fileError('RUN_FILE_NOT_REGULAR', '产出路径不是普通文件', 409)
  if (platform !== 'darwin') {
    throw fileError('RUN_FILE_OPEN_UNSUPPORTED', '当前仅支持在 macOS 上使用默认应用打开文件', 409)
  }
  try {
    await execFileImpl('/usr/bin/open', [pathToFileURL(canonicalTarget).href], { timeout: 5000, shell: false })
  } catch {
    throw fileError('RUN_FILE_OPEN_FAILED', '无法打开文件，请检查系统默认应用关联', 409)
  }
  return { opened: true, path }
}
