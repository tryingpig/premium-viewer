# premium-viewer

`tryingpig/premium-contents`(비공개) 에 보존한 네이버 프리미엄 원문 HTML 을 보는 정적 뷰어.

**이 repo 에는 본문이 한 줄도 들어있지 않다.** 화면에 뿌리는 내용은 전부 브라우저가
GitHub API 로 비공개 저장소에서 직접 읽어온다. 토큰은 그 브라우저 localStorage 에만 남는다.

- 주소: https://tryingpig.github.io/premium-viewer/
- 필요 토큰: `premium-contents` 에 **Contents: Read** 권한이 있는 PAT
- 딥링크: `#/` 홈 · `#/c/<채널id>` 채널 목록 · `#/a/<기사id>` 기사
