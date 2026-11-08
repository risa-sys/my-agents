#!/usr/bin/env bash
# 候補履歴(data/fb-post-history.json)を専用ブランチ fb-history で保存・復元する。main には書き込まない。
#   restore … fb-history ブランチの履歴を data/fb-post-history.json に取り出す(ブランチが無ければ何もしない)
#   save    … data/fb-post-history.json を fb-history ブランチにコミットして push する(変更が無ければ何もしない)
set -euo pipefail

BRANCH="${FB_HISTORY_BRANCH:-fb-history}"
REMOTE="${FB_HISTORY_REMOTE:-origin}"
FILE="data/fb-post-history.json"

if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  echo "履歴を $BRANCH ブランチには保存しません" >&2
  exit 1
fi

remote_has_branch() {
  git ls-remote --exit-code --heads "$REMOTE" "$BRANCH" >/dev/null 2>&1
}

case "${1:-}" in
  restore)
    if ! remote_has_branch; then
      echo "$BRANCH ブランチはまだありません。リポジトリの $FILE から始めます"
      exit 0
    fi
    git fetch --quiet --depth=1 "$REMOTE" "$BRANCH"
    if git cat-file -e "FETCH_HEAD:$FILE" 2>/dev/null; then
      mkdir -p "$(dirname "$FILE")"
      git show "FETCH_HEAD:$FILE" > "$FILE"
      echo "履歴を $BRANCH ブランチから復元しました(記録 $(grep -c '"productId"' "$FILE" || true) 件)"
    else
      echo "$BRANCH ブランチに $FILE がありません。リポジトリの $FILE から始めます"
    fi
    ;;

  save)
    if [ ! -f "$FILE" ]; then
      echo "$FILE がありません" >&2
      exit 1
    fi
    if grep -q '"dataSource": *"mock"' "$FILE"; then
      echo "テスト用データの記録が含まれているため保存しません" >&2
      exit 1
    fi
    tmp="$(mktemp -d)"
    trap 'git worktree remove --force "$tmp" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
    if remote_has_branch; then
      git fetch --quiet --depth=1 "$REMOTE" "$BRANCH"
      git worktree add --quiet --detach "$tmp" FETCH_HEAD
    else
      # 初回: 履歴ファイルだけを持つ、main とは履歴を共有しないブランチを作る
      git worktree add --quiet --detach "$tmp"
      git -C "$tmp" checkout --quiet --orphan "fb-history-new"
      git -C "$tmp" rm -rq --cached . >/dev/null 2>&1 || true
      find "$tmp" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
    fi
    mkdir -p "$tmp/$(dirname "$FILE")"
    cp "$FILE" "$tmp/$FILE"
    git -C "$tmp" add "$FILE"
    if git -C "$tmp" diff --cached --quiet; then
      echo "履歴に変更はありません($BRANCH ブランチは更新しません)"
      exit 0
    fi
    git -C "$tmp" -c user.name="github-actions[bot]" -c user.email="41898283+github-actions[bot]@users.noreply.github.com" \
      commit --quiet -m "Update Facebook post candidate history"
    git -C "$tmp" push --quiet "$REMOTE" "HEAD:refs/heads/$BRANCH"
    echo "履歴を $BRANCH ブランチに保存しました"
    ;;

  *)
    echo "usage: $0 restore|save" >&2
    exit 2
    ;;
esac
