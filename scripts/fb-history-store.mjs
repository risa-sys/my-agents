/**
 * fb-history ブランチの履歴(data/fb-post-history.json)の読み書き(投稿予約で使う)。
 * - 読むたびに fb-history の最新を取得する(main やこのPCの data/ の履歴は使わない)
 * - 保存は fb-history-branch.sh save に任せ、読み込んだ後に更新されていたら保存しない(FB_HISTORY_EXPECT)
 * - 1件の状態を変えるときは transition() を使う: 最新を読み直し、想定した状態のときだけ変えて保存する。
 *   別の実行と同時に書き込もうとして保存できなかったときは、読み直してやり直す(最大3回)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HISTORY_PATH = 'data/fb-post-history.json';

export class HistoryConflict extends Error {}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 保存先が GitHub ではなく、ローカルのテスト用リポジトリか */
export function remoteIsLocalTest(remote) {
  if (/^(origin|https?:\/\/|git@|ssh:\/\/)/.test(remote)) return false;
  return existsSync(remote) && statSync(remote).isDirectory();
}

export function createHistoryStore({ remote = 'origin', branch = 'fb-history', dryRun = false, log = console.log } = {}) {
  if (branch === 'main' || branch === 'master') throw new Error(`履歴を ${branch} ブランチでは扱いません`);

  function load() {
    try {
      git(['fetch', '--quiet', '--depth=1', remote, branch]);
    } catch (e) {
      throw new Error(`${branch} ブランチを取得できませんでした(${String(e.stderr || e.message).trim()})`);
    }
    const commit = git(['rev-parse', 'FETCH_HEAD']).trim();
    const history = JSON.parse(git(['show', `FETCH_HEAD:${HISTORY_PATH}`]));
    if (!history || !Array.isArray(history.entries)) throw new Error(`${branch} の履歴の形式が不正です`);
    return { history, commit };
  }

  function save(history, commit, message) {
    const dir = mkdtempSync(join(tmpdir(), 'fb-publish-'));
    try {
      const file = join(dir, 'fb-post-history.json');
      writeFileSync(file, JSON.stringify(history, null, 2) + '\n');
      const script = fileURLToPath(new URL('./fb-history-branch.sh', import.meta.url)).replace(/\\/g, '/');
      execFileSync('bash', [script, 'save'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          FB_HISTORY_REMOTE: remote,
          FB_HISTORY_BRANCH: branch,
          FB_HISTORY_SOURCE: file.replace(/\\/g, '/'),
          FB_HISTORY_EXPECT: commit,
          FB_HISTORY_MESSAGE: message,
          FB_HISTORY_ALLOW_MOCK: ''
        }
      });
    } catch (e) {
      throw new HistoryConflict(`fb-history に保存できませんでした: ${String(e.stderr || e.message).trim().split('\n').pop()}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * 1件の状態を変えて保存する。
   * find(history) で対象を探し、check(entry) が真のときだけ mutate(entry, history) を適用する。
   * check が偽なら(別の実行が先に変えていたら)何もせず null を返す。
   */
  function transition({ find, check, mutate, message }) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { history, commit } = load();
      const entry = find(history);
      if (!entry || !check(entry)) return null;
      mutate(entry, history);
      if (dryRun) {
        log(`(確認のみ: 履歴は保存しません)${message}`);
        return entry;
      }
      try {
        save(history, commit, message);
        return entry;
      } catch (e) {
        if (!(e instanceof HistoryConflict) || attempt === 3) throw e;
        log(`${e.message} → 読み直してやり直します(${attempt}/3)`);
      }
    }
    return null;
  }

  /** 履歴全体に対する変更(最新を読み直して適用し、保存する)。apply が false を返したら保存しない */
  function update({ apply, message }) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { history, commit } = load();
      if (apply(history) === false) return false;
      if (dryRun) {
        log(`(確認のみ: 履歴は保存しません)${message}`);
        return true;
      }
      try {
        save(history, commit, message);
        return true;
      } catch (e) {
        if (!(e instanceof HistoryConflict) || attempt === 3) throw e;
        log(`${e.message} → 読み直してやり直します(${attempt}/3)`);
      }
    }
    return false;
  }

  return { load, transition, update };
}
