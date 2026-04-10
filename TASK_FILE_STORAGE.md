# 任务文件存储与管理

## 功能概述

系统已实现完整的任务文件永久存储机制：

1. **自动保存输入文件** - 用户上传的 TXT 文件被永久保存
2. **自动保存输出文件** - 生成的所有结果文件（Excel/TXT）被保存
3. **文件组织** - 按日期层级组织：`data/task-files/YYYY/MM/DD/`
4. **管理员查询** - 完整的 API 支持查询、下载、导出历史文件

## 数据存储结构

### 文件系统

```
data/task-files/
├── 2026/
│   ├── 04/
│   │   ├── 10/
│   │   │   ├── input_1712776234567_checknum.txt      # 用户上传的输入
│   │   │   └── output_1712776234567_checknum_....xlsx # 生成的输出
│   │   └── 11/
│   │       ├── input_...txt
│   │       ├── output_...txt
│   │       └── output_...xlsx
```

### 数据库

```sql
task_history 表新增字段：
- input_file_path TEXT     -- 输入文件的完整路径
- output_file_path TEXT    -- 输出文件的完整路径
```

## 管理员 API

### 1. 查询任务历史

**请求**

```
GET /api/admin/task-history?user_id=1&mode=checknum&limit=100&offset=0
Authorization: Bearer <JWT token>
```

**参数**

- `user_id` (可选) - 筛选特定用户
- `mode` (可选) - 筛选任务模式 (checknum|probe|checknumlist|activity|wsdebug|behavior)
- `limit` (可选) - 返回记录数，默认 100，最多 1000
- `offset` (可选) - 分页偏移，默认 0
- `from_date` (可选) - 开始日期 (ISO 8601)
- `to_date` (可选) - 结束日期 (ISO 8601)

**响应**

```json
{
    "ok": true,
    "total": 42,
    "limit": 100,
    "offset": 0,
    "items": [
        {
            "id": 1,
            "user_id": 2,
            "username": "operator1",
            "mode": "checknum",
            "input_count": 50,
            "output_count": 45,
            "stopped_early": false,
            "input_file_path": "/workspaces/WS-01/tools/visual-ui/data/task-files/2026/04/10/input_1712776234567_checknum.txt",
            "output_file_path": "/workspaces/WS-01/tools/visual-ui/data/task-files/2026/04/10/output_1712776234567_checknum_2026-04-10T12:03:54.567Z.xlsx",
            "created_at": "2026-04-10T12:03:54.567Z"
        }
    ]
}
```

### 2. 下载单个文件

**请求**

```
GET /api/admin/task-files/:taskId/input
GET /api/admin/task-files/:taskId/output
Authorization: Bearer <JWT token>
```

**示例**

```bash
# 下载输入文件
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3399/api/admin/task-files/1/input" \
  -o input_file.txt

# 下载输出文件
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3399/api/admin/task-files/1/output" \
  -o result_file.xlsx
```

### 3. 导出所有文件为 ZIP

**请求**

```
POST /api/admin/task-files/export
Authorization: Bearer <JWT token>
Content-Type: application/json
```

**请求体**

```json
{
    "user_id": 2, // 可选：筛选用户
    "mode": "checknum", // 可选：筛选模式
    "from_date": "2026-04-01T00:00:00Z", // 可选：开始日期
    "to_date": "2026-04-30T23:59:59Z" // 可选：结束日期
}
```

**响应**

返回 ZIP 文件下载，文件结构如下：

```
task-files-export-1712776234567.zip
├── operator1/
│   ├── 2026-04-10/
│   │   ├── checknum/
│   │   │   ├── input_1.txt
│   │   │   ├── output_1.xlsx
│   │   │   ├── input_2.txt
│   │   │   └── output_2.xlsx
│   │   └── probe/
│   │       ├── input_3.txt
│   │       └── output_3.txt
│   └── 2026-04-11/
│       └── ...
├── operator2/
│   └── ...
```

## 使用示例

### 使用 curl 查询任务历史

```bash
# 获取所有任务
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3399/api/admin/task-history"

# 查询特定用户在特定日期的任务
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3399/api/admin/task-history?user_id=2&from_date=2026-04-10T00:00:00Z&to_date=2026-04-10T23:59:59Z"

# 查询特定任务模式
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3399/api/admin/task-history?mode=checknum&limit=50"
```

### 使用 Python 导出文件归档

```python
import requests
import json

TOKEN = "your_jwt_token"
BASE_URL = "http://localhost:3399"

# 导出特定用户在特定日期的所有任务文件
export_params = {
    "user_id": 2,
    "from_date": "2026-04-01T00:00:00Z",
    "to_date": "2026-04-30T23:59:59Z"
}

headers = {"Authorization": f"Bearer {TOKEN}"}
response = requests.post(
    f"{BASE_URL}/api/admin/task-files/export",
    json=export_params,
    headers=headers
)

# 保存 ZIP 文件
if response.status_code == 200:
    with open("task-export.zip", "wb") as f:
        f.write(response.content)
    print("导出成功!")
else:
    print(f"导出失败: {response.json()}")
```

## 访问控制

所有文件管理 API **仅限管理员访问**。

- 非管理员用户将收到 `403 Forbidden` 响应
- 访问需要有效的 JWT token 且 `role` 必须为 `'admin'`

## 自动清理

目前系统不自动删除旧文件。建议定期：

1. **手动清理**过期文件

    ```bash
    # 删除 3 个月前的文件
    find ./data/task-files -type f -mtime +90 -delete
    ```

2. **定期导出**重要数据到外部存储

3. **监控磁盘空间** - 定期检查 `data/task-files` 目录大小

## 注意事项

### 文件大小限制

- 单个输出文件（Excel/TXT）建议不超过 500MB
- ZIP 导出大量数据时可能耗时较长（> 10 分钟）

### 数据隐私

- 已保存的文件包含所有任务数据（用户号码、结果等）
- 确保正确限制 `data/task-files` 目录的文件系统权限
- 考虑对敏感文件进行加密存储

### 数据恢复

文件系统和数据库记录是同步的。如果误删文件：

1. 检查 `data/task-files` 中是否有备份
2. 从数据库 `task_history` 表检查记录
3. 根据 `input_file_path` 和 `output_file_path` 定位文件

## 技术实现细节

### 文件保存流程

1. 任务执行时，输入和输出数据生成为 Buffer
2. 文件保存到 `getTaskFileDir()` 返回的日期目录
3. 文件路径存储在 `task_history` 表
4. 实时返回 Base64 编码的文件给前端（兼容性）

### 目录创建

格式：`YYYY/MM/DD/`

- 自动创建不存在的中间目录
- 使用系统时间戳，具有时区意识

### 文件命名规则

```
input:  input_[timestamp]_[mode].txt
output: output_[timestamp]_[filename]
```

示例：

- `input_1712776234567_checknum.txt`
- `output_1712776234567_checknum_2026-04-10T12:03:54.567Z.xlsx`
