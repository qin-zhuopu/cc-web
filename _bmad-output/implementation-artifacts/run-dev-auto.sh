#!/usr/bin/env bash
# =============================================================================
# run-dev-auto.sh —— bmad-dev-auto 全自动开发外层编排脚本
# -----------------------------------------------------------------------------
# 作用：按 stories.yaml 的执行顺序，逐个故事以 folder+id 分派模式驱动
#       bmad-dev-auto（headless 无人值守）。dev-auto 自己一次只跑一个故事，
#       本脚本负责「挑下一个」+ 在 checkpoint / blocked 处停下等人。
#
# 依赖：
#   - claude CLI（headless 模式 `claude -p`）
#   - python3 / uv（解析 stories.yaml + 各故事 spec frontmatter 的 status）
#
# 用法：
#   bash run-dev-auto.sh <epic-dir>                 # 跑一个 epic 的全部故事
#   bash run-dev-auto.sh <epic-dir> --from sk-1-2   # 从指定故事 id 起跑
#   bash run-dev-auto.sh <epic-dir> --dry-run       # 只打印将要分派的故事，不真跑
#   bash run-dev-auto.sh <epic-dir> --yes           # 忽略 spec_checkpoint，一路跑到底
#
# 例：
#   bash _bmad-output/implementation-artifacts/run-dev-auto.sh \
#        _bmad-output/implementation-artifacts/epic-sk-1
#
# 停止条件（脚本会退出并提示）：
#   1. 某故事 spec frontmatter 的 status 变为 blocked        -> 需要人介入
#   2. 该故事 stories.yaml 里 spec_checkpoint=true            -> 需要人评审 spec
#   3. dev-auto 进程非零退出                                  -> 报错停下
#   4. 全部故事 status=done                                   -> 正常完成
# =============================================================================

set -euo pipefail

# ---- Python 解释器探测（本机无 python3，退回 python / py）------------------
detect_python() {
  for cand in python3 python py; do
    if command -v "$cand" >/dev/null 2>&1; then echo "$cand"; return 0; fi
  done
  echo "找不到 python3 / python / py，脚本依赖 Python 解析 YAML。" >&2
  exit 2
}
PY_BIN="$(detect_python)"

# ---- Git 解释器（Git-Bash 下裸 git 输出异常，优先用 mingw64 全路径）--------
GIT_BIN="git"
[[ -x /mingw64/bin/git ]] && GIT_BIN=/mingw64/bin/git

# ---- 参数解析 --------------------------------------------------------------
EPIC_DIR="${1:-}"
if [[ -z "$EPIC_DIR" ]]; then
  echo "用法: bash run-dev-auto.sh <epic-dir> [--from <story-id>] [--dry-run] [--yes]" >&2
  exit 2
fi
shift || true

FROM_ID=""
DRY_RUN=0
IGNORE_CHECKPOINT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM_ID="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes) IGNORE_CHECKPOINT=1; shift ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

# ---- 路径规范化 ------------------------------------------------------------
# 以脚本所在目录的上两级为 project-root（implementation-artifacts -> _bmad-output -> root）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
EPIC_DIR="$(cd "$EPIC_DIR" && pwd)"
STORIES_YAML="$EPIC_DIR/stories.yaml"

if [[ ! -f "$STORIES_YAML" ]]; then
  echo "找不到 $STORIES_YAML" >&2
  exit 2
fi

# ---- 用 python 读出有序 story id 列表 + 每个 id 的 spec_checkpoint --------
# 输出格式：每行 "<id>\t<spec_checkpoint 0|1>"
mapfile -t STORY_ROWS < <("$PY_BIN" - "$STORIES_YAML" <<'PY'
import sys, yaml
with open(sys.argv[1], encoding="utf-8") as f:
    stories = yaml.safe_load(f) or []
for s in stories:
    cp = "1" if s.get("spec_checkpoint") else "0"
    print(f"{s['id']}\t{cp}")
PY
)

if [[ ${#STORY_ROWS[@]} -eq 0 ]]; then
  echo "stories.yaml 中没有故事条目。" >&2
  exit 2
fi

# ---- 读某故事 spec 文件的 status（不存在则返回 none）----------------------
story_status() {
  local id="$1"
  local match
  match=$(ls "$EPIC_DIR"/stories/"${id}"-*.md 2>/dev/null | head -1 || true)
  if [[ -z "$match" ]]; then
    echo "none"; return
  fi
  "$PY_BIN" - "$match" <<'PY'
import sys, re
text = open(sys.argv[1], encoding="utf-8").read()
m = re.match(r"^---\n(.*?)\n---", text, re.S)
if not m:
    print("unknown"); sys.exit()
import yaml
fm = yaml.safe_load(m.group(1)) or {}
print(fm.get("status", "unknown"))
PY
}

# ---- Git 保护：工作区是否干净 ---------------------------------------------
# 返回 0=干净，1=有未提交改动。用 porcelain 判定（无输出即干净）。
worktree_clean() {
  local out
  out="$("$GIT_BIN" -C "$PROJECT_ROOT" status --porcelain 2>/dev/null)"
  [[ -z "$out" ]]
}

# ---- Git 保护：故事完成后形成干净断点提交 ---------------------------------
# 把该故事产生的全部改动提交为一个断点，供中断后 --from 续跑 / 回滚到故事边界。
commit_story() {
  local id="$1"
  if worktree_clean; then
    echo "    [$id] 无改动可提交（跳过 commit）。"
    return 0
  fi
  "$GIT_BIN" -C "$PROJECT_ROOT" add -A
  "$GIT_BIN" -C "$PROJECT_ROOT" commit -q -m "feat(dev-auto): 完成故事 ${id}

由 run-dev-auto.sh 无人值守链路自动提交，形成故事边界断点。

Co-Authored-By: Claude <noreply@anthropic.com>"
  echo "    [$id] 已提交断点：$("$GIT_BIN" -C "$PROJECT_ROOT" rev-parse --short HEAD)"
}

# ---- 驱动单个故事 ----------------------------------------------------------
dispatch_story() {
  local id="$1"
  local prompt="调用 bmad-dev-auto skill。folder+id 分派模式：spec 文件夹为 ${EPIC_DIR}，故事 id 为 ${id}。请对该故事跑完一次无人值守开发循环（plan -> implement -> review），完成后把结果写回 id 对应的 story spec 文件。"
  echo ">>> 分派故事 [$id]"
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "    (dry-run) 将执行: claude -p <folder+id 分派提示>"
    return 0
  fi
  # headless 无人值守：--dangerously-skip-permissions 让子进程不因权限交互卡住
  # （无人值守场景的常规做法；如需人工确认可去掉此旗标改用交互模式）
  claude -p "$prompt" --dangerously-skip-permissions
}

# ---- 主循环 ----------------------------------------------------------------
STARTED=0
[[ -z "$FROM_ID" ]] && STARTED=1

for row in "${STORY_ROWS[@]}"; do
  id="${row%%$'\t'*}"
  checkpoint="${row##*$'\t'}"

  # --from 支持：跳到指定 id 才开始
  if [[ $STARTED -eq 0 ]]; then
    if [[ "$id" == "$FROM_ID" ]]; then STARTED=1; else continue; fi
  fi

  st="$(story_status "$id")"
  echo "=== 故事 [$id] 当前 status=$st spec_checkpoint=$checkpoint ==="

  # 已完成则跳过
  if [[ "$st" == "done" ]]; then
    echo "    已 done，跳过。"
    continue
  fi

  # Git 保护：dispatch 前工作区必须干净，否则上一步残留改动会与本故事串味，
  # 中断后难以回滚到干净的故事边界。dry-run 不检查。
  if [[ $DRY_RUN -eq 0 ]] && ! worktree_clean; then
    echo "!!! dispatch 故事 [$id] 前工作区不干净，存在未提交改动。停止编排。" >&2
    echo "    请先手动提交或丢弃改动，再用 --from $id 续跑。" >&2
    "$GIT_BIN" -C "$PROJECT_ROOT" status --short >&2
    exit 1
  fi

  # 已 blocked：停下等人
  if [[ "$st" == "blocked" ]]; then
    echo "!!! 故事 [$id] 处于 blocked，需人工介入。停止编排。" >&2
    echo "    请查看 $EPIC_DIR/stories/${id}-*.md 的 ## Auto Run Result。" >&2
    exit 1
  fi

  # spec_checkpoint：分派一次（跑到 in-review 前会停），然后要求人评审
  dispatch_story "$id"

  # dispatch 后重新读 status 决定是否继续
  [[ $DRY_RUN -eq 1 ]] && continue
  st_after="$(story_status "$id")"
  echo "--- 故事 [$id] 分派后 status=$st_after ---"

  case "$st_after" in
    done)
      echo "    [$id] 完成。"
      # Git 保护：完成即提交，形成干净的故事边界断点。
      commit_story "$id"
      ;;
    blocked)
      echo "!!! [$id] 分派后 blocked，停止编排等人处理。" >&2
      exit 1
      ;;
    *)
      if [[ "$checkpoint" == "1" && $IGNORE_CHECKPOINT -eq 0 ]]; then
        echo "*** [$id] 设了 spec_checkpoint，且未 done（status=$st_after）。" >&2
        echo "    按约定在此暂停，请人工评审 spec 后用 --from $id 续跑。" >&2
        exit 0
      fi
      echo "    [$id] 未 done（status=$st_after）但无 checkpoint，继续下一个。" >&2
      ;;
  esac
done

echo "=== 编排结束：epic $(basename "$EPIC_DIR") 所有故事处理完毕。 ==="
