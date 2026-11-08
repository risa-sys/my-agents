#!/usr/bin/env bash
# 候補履歴(data/fb-post-history.json)を専用ブランチ fb-history で保存・復元する。main には書き込まない。
#   restore … fb-history ブランチの履歴を data/fb-post-history.json に取り出す(ブランチが無ければ何もしない)
#   save    … 履歴ファイルを fb-history ブランチにコミットして push する(変更が無ければ何もしない)
# 環境変数(save):
#   FB_HISTORY_SOURCE  … 保存する履歴ファイル(既定: data/fb-post-history.json)
#   FB_HISTORY_EXPECT  … fb-history の現在のコミット。違っていたら(読んだ後に更新されていたら)保存しない
#   FB_HISTORY_MESSAGE … コミットメッセージ
#   FB_HISTORY_ALLOW_MOCK=1 … テスト用の記録を許す(保存先がローカルのテスト用リポジトリのときだけ有効)
set -euo pipefail

BRANCH="${FB_HISTORY_BRANCH:-fb-history}"
REMOTE="${FB_HISTORY_REMOTE:-origin}"
FILE="data/fb-post-history.json"
SOURCE="${FB_HISTORY_SOURCE:-$FILE}"
MESSAGE="${FB_HISTORY_MESSAGE:-Update Facebook post candidate history}"

if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  echo "履歴を $BRANCH ブランチには保存しません" >&2
  exit 1
fi

remote_has_branch() {
  git ls-remote --exit-code --heads "$REMOTE" "$BRANCH" >/dev/null 2>&1
}

# 保存先が GitHub など(リモート名 origin や URL)ではなく、ローカルのテスト用リポジトリか
remote_is_local_test() {
  case "$REMOTE" in
    origin|http://*|https://*|git@*|ssh://*) return 1 ;;
    *) [ -d "$REMOTE" ] ;;
  esac
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
    if [ ! -f "$SOURCE" ]; then
      echo "$SOURCE がありません" >&2
      exit 1
    fi
    if grep -q '"dataSource": *"mock"' "$SOURCE"; then
      if [ "${FB_HISTORY_ALLOW_MOCK:-}" = "1" ] && remote_is_local_test; then
        echo "(テスト用リポジトリへの保存のため、テスト用の記録を許可します)"
      else
        echo "テスト用データの記録が含まれているため保存しません" >&2
        exit 1
      fi
    fi
    tmp="$(mktemp -d)"
    trap 'git worktree remove --force "$tmp" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
    if remote_has_branch; then
      git fetch --quiet --depth=1 "$REMOTE" "$BRANCH"
      if [ -n "${FB_HISTORY_EXPECT:-}" ] && [ "$(git rev-parse FETCH_HEAD)" != "$FB_HISTORY_EXPECT" ]; then
        echo "$BRANCH が読み込んだ後に更新されています。もう一度内容を確認してから反映してください(保存していません)" >&2
        exit 1
      fi
      git worktree add --quiet --detach "$tmp" FETCH_HEAD
    else
      if [ -n "${FB_HISTORY_EXPECT:-}" ]; then
        echo "$BRANCH ブランチがありません(保存していません)" >&2
        exit 1
      fi
      # 初回: 履歴ファイルだけを持つ、main とは履歴を共有しないブランチを作る
      git worktree add --quiet --detach "$tmp"
      git -C "$tmp" checkout --quiet --orphan "fb-history-new"
      git -C "$tmp" rm -rq --cached . >/dev/null 2>&1 || true
      find "$tmp" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
    fi
    mkdir -p "$tmp/$(dirname "$FILE")"
    cp "$SOURCE" "$tmp/$FILE"
    git -C "$tmp" add "$FILE"
    if git -C "$tmp" diff --cached --quiet; then
      echo "履歴に変更はありません($BRANCH ブランチは更新しません)"
      exit 0
    fi
    git -C "$tmp" -c user.name="${FB_HISTORY_AUTHOR_NAME:-github-actions[bot]}" -c user.email="${FB_HISTORY_AUTHOR_EMAIL:-41898283+github-actions[bot]@users.noreply.github.com}" \
      commit --quiet -m "$MESSAGE"
    git -C "$tmp" push --quiet "$REMOTE" "HEAD:refs/heads/$BRANCH"
    echo "履歴を $BRANCH ブランチに保存しました"
    ;;

  *)
    echo "usage: $0 restore|save" >&2
    exit 2
    ;;
esac
