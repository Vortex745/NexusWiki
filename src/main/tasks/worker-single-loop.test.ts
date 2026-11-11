import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { formatSkillsForPrompt } from '@earendil-works/pi-coding-agent'
import { ensureWorkerSkills, loadWorkerSkills, runWorker, validateArtifacts } from './worker.ts'

// PRD v0.3 Worker 单环化探针：产物校验、技能播种/加载、回合预算截断

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'worker-single-loop-'))
}

test('validateArtifacts accepts real files and rejects missing, escaping and directory paths', () => {
  const dir = makeTempDir()
  try {
    const taskDir = join(dir, 'task')
    mkdirSync(taskDir, { recursive: true })
    writeFileSync(join(taskDir, 'ok.js'), 'ok')
    mkdirSync(join(taskDir, 'sub'))

    assert.deepEqual(validateArtifacts(taskDir, ['ok.js']), [])
    assert.deepEqual(validateArtifacts(taskDir, ['ok.js', 'ok.js']), [])

    const missing = validateArtifacts(taskDir, ['missing.js'])
    assert.equal(missing.length, 1)
    assert.ok(missing[0]?.includes('不存在'), `missing artifact reason, got: ${missing.join('；')}`)

    const escaping = validateArtifacts(taskDir, ['../outside.js'])
    assert.ok(escaping[0]?.includes('越界'), `escaping artifact reason, got: ${escaping.join('；')}`)

    const directory = validateArtifacts(taskDir, ['sub'])
    assert.ok(directory[0]?.includes('不是文件'), `directory artifact reason, got: ${directory.join('；')}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureWorkerSkills seeds two skills and loadWorkerSkills ignores cwd default skill dirs', () => {
  const dir = makeTempDir()
  try {
    const agentDir = join(dir, 'agent')
    const taskDir = join(dir, 'workspace', 'skill-task')
    mkdirSync(taskDir, { recursive: true })
    // 用户目录里的诱饵技能：includeDefaults=false 时不应被扫描到
    const decoyDir = join(taskDir, '.pi', 'skills', 'decoy')
    mkdirSync(decoyDir, { recursive: true })
    writeFileSync(
      join(decoyDir, 'SKILL.md'),
      ['---', 'name: decoy', 'description: 不应被加载的诱饵技能', '---', '', 'decoy body'].join('\n')
    )

    ensureWorkerSkills(agentDir)
    ensureWorkerSkills(agentDir) // 幂等：重跑不覆盖

    const result = loadWorkerSkills(taskDir, agentDir)
    const names = result.skills.map((skill) => skill.name).sort()
    assert.deepEqual(names, ['command-run', 'file-edit'])
    assert.equal(result.diagnostics.length, 0, `skills must load cleanly, got: ${JSON.stringify(result.diagnostics)}`)

    const prompt = formatSkillsForPrompt(result.skills)
    assert.ok(prompt.includes('file-edit'), 'skill prompt mentions file-edit')
    assert.ok(prompt.includes('command-run'), 'skill prompt mentions command-run')
    for (const skill of result.skills) {
      assert.ok(prompt.includes(skill.description), `skill prompt carries description of ${skill.name}`)
    }
    assert.ok(!prompt.includes('decoy'), 'cwd default skill dirs must not be scanned')

    // 幂等：已有文件内容保留
    const skillFile = join(agentDir, 'skills', 'file-edit', 'SKILL.md')
    const before = readFileSync(skillFile, 'utf8')
    ensureWorkerSkills(agentDir)
    assert.equal(readFileSync(skillFile, 'utf8'), before)
    assert.ok(existsSync(join(agentDir, 'skills', 'command-run', 'SKILL.md')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runWorker stops at the turn budget and reports unfinished work with artifacts', async () => {
  const dir = makeTempDir()
  try {
    const workspaceRoot = join(dir, 'workspace')
    const outcome = await runWorker({
      taskId: 'budget-task',
      prompt: '写一个 长任务 slow.js',
      mode: 'fake',
      agentDir: dir,
      workspaceRoot,
      maxTurns: 3
    })

    assert.equal(outcome.status, 'failed')
    assert.ok(outcome.report.includes('未完成'), `budget report must say unfinished, got: ${outcome.report}`)
    assert.ok(outcome.report.includes('step-1.js'), `budget report lists task files, got: ${outcome.report}`)
    assert.ok(existsSync(join(workspaceRoot, 'budget-task', 'slow.js')), 'worker wrote its first artifact')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
