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
mapfile -t STORY_ROWS < <(python3 - "$STORIES_YAML" <<'PY'
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
  python3 - "$match" <<'PY'
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
