# 班记

浏览器内使用的考勤与工资记录工具，无需后端或安装依赖。PDF 解析与 OCR 资源随项目提供。

## GitHub Pages 部署

1. 将项目完整内容上传至仓库的 `main` 分支根目录，保留 `.github`、`.nojekyll` 和 `payroll` 内的全部资源。
2. 在仓库 **Settings → Pages → Build and deployment → Source** 中选择 **GitHub Actions**。
3. 推送后，在 **Actions → Deploy Banji to GitHub Pages** 中查看部署结果；需要时点击 **Run workflow** 重新部署。
4. 部署完成后使用 Pages 提供的 HTTPS 链接打开。

该工作流只发布网页及所需资源。若使用其他默认分支，请相应修改工作流的 `branches`。

## 本地预览

在项目目录运行 `python3 -m http.server 8000`，浏览器打开 `http://localhost:8000`。

## 数据保存

记录保存在当前浏览器的本地存储中，不会自动同步到其他浏览器或设备。请使用应用内备份功能保留数据；清除网站数据会删除本地记录。
