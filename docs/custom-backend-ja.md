# Codex app を改造 CLI で使う

★ 公式アプリ本体を変更せず、`CODEX_CLI_PATH` で外部の改造 CLI をバックエンドに指定する任意のランチャーを追加しました。通常の Voice インストールでは有効になりません。

## 実装と使い方

[launch-custom-codex-app.mjs](../launch-custom-codex-app.mjs) は、前回の実機検証で使った個人用ランチャーを、個人のパスを埋め込まずに公開したものです。起動・切り替え処理は維持し、設定ファイルの指定、リポジトリの場所の既定値、ヘルプを追加しています。公開版についても構文と既存プロファイルを使った読み取り専用の状態確認を検証しました。

設定ファイルは `CHATGPT_CUSTOM_CODEX_PROFILE` で指定できます。省略時は `~/.local/lib/codex-custom/profile.json` を読みます。実際の個人用プロファイルやバイナリはこのリポジトリに含めていません。

1. 改造済みのネイティブ実行ファイル `codex` と、対応する `codex-code-mode-host` を、アプリの外のバージョン付きフォルダへコピーします。npm の `codex.js` ではなくネイティブ実行ファイルを使い、ファイル名を保持してください。元の CLI やアプリ内のファイルは置き換えません。
2. 両ファイルの `shasum -a 256` と、対象アプリのバージョン／ビルドを確認します。
3. [設定例](../custom-codex-profile.example.json) をアプリ外の場所へコピーし、自分の絶対パスとハッシュを記入します。例に書かれたバージョンは今回の検証値であり、別の組み合わせへの互換性保証ではありません。`~` や `$HOME` は JSON のパス内では展開しません。
4. その設定を指定して起動し、実際の app-server とツール実行を確認します。

```bash
export CHATGPT_CUSTOM_CODEX_PROFILE=/absolute/path/to/your/profile.json
node launch-custom-codex-app.mjs
node launch-custom-codex-app.mjs --status
```

`voiceRepository` は省略するとこのスクリプトのあるディレクトリを使います。スクリプトだけを別の場所に置く場合は、プロファイルにリポジトリの絶対パスを指定してください。

ランチャーは次を行います。

- ★ 起動前に固定した CLI と code-mode host のハッシュ、App のバージョン／ビルド、CLI の署名の整合性を検査します。署名検証の成功は、Chrome の接続で必要な署名 ID を持つことを意味しません。
- `CODEX_CLI_PATH` と `CODEX_APP_SERVER_FORCE_CLI=1` を、そのアプリの起動だけに渡します。`.zshrc` や `launchctl` のグローバル環境は変更しません。
- 別のバックエンドで起動中なら、アプリを前面に出して正常終了を要求します。終了確認は尊重し、キャンセルやタイムアウト時に強制終了しません。他の CLI セッションも終了しません。
- 実際に起動したアプリの子プロセスが指定した `codex` かを確認し、Voice パッチを適用します。ディスク上の `--version` だけでは成功と判定しません。

App 更新後は、再検証するまでカスタム起動を拒否します。検査値を書き換えるだけでは再検証の代わりになりません。また、普段の CLI を更新しても固定コピーは自動更新されません。

## 同梱版へ戻す

```bash
node launch-custom-codex-app.mjs --bundled
```

同梱 CLI を明示して起動し、Voice パッチは維持します。更新後に Voice パッチが非互換なら、その適用はエラーになります。完全な通常起動へ戻す場合はアプリを終了して公式アイコンから直接起動します。

公式アプリを完全終了してから元のアイコンで起動した場合、専用ランチャーの設定は適用されません。改造版を使うときはランチャーから起動してください。

GUI の入口が必要なら、[AppleScript の例](../examples/Codex%20Custom.applescript) の Node とリポジトリの絶対パスを編集して、別名のアプリへコンパイルできます。パスに空白がある場合は `launcherCommand` 内でシェルの引用符を使ってください。

```bash
osacompile -o "$HOME/Applications/Codex Custom.app" "examples/Codex Custom.applescript"
```

同名アプリが既にある場合は、この出力先に上書きせず別名を指定してください。

## 実機検証した組み合わせ

| 項目 | 値 |
| --- | --- |
| 日付 | 2026-09-13 JST |
| App | 26.908.40834、build 8881 |
| App の同梱 CLI | 0.154.0-alpha.6.2 |
| 使用した改造 CLI | 0.153.4 |
| 改造 CLI の SHA-256 | `2bf9852639cb9b1ff4238a41ea84d9620e4a806396e89132fb896a1e7294d1ad` |

★ アプリが改造 CLI を `app-server` として起動し、アプリのログで `currentVersion=0.153.4` と初期接続成功を確認しました。

既存のテスト用スレッドで、合成音声をアプリのマイク入力へ一時的に接続しました。Voice／WebRTC／音声モデルから同じバックエンドへ引き継がれ、ネイティブ `monitor` を実際に呼びました。2 秒後の「確認完了」という出力と終了通知を受信し、元の確認コード `QUARTZ-318` とともに読み上げました。制御タグを除いたバックエンド回答と最終発話は一致しました。monitor を MCP へ作り直していません。

テスト後は通話を終了し、マイク入力の差し替えを両画面から解除しました。これは物理マイクの検証ではありません。

同梱版への復帰と、専用ランチャーによる改造版への再切り替えでも、双方の初期接続成功を確認しました。最初の `--bundled` は終了確認で一度キャンセルされています。その後アプリの終了を確認し、公式起動で同梱版へ戻してからランチャーで改造版へ切り替えました。`--bundled` の自動実行が初回から完走したという記録ではありません。

個人のパス・テストセッション ID・インストール済みアプリ名を伏せた [検証記録](custom-backend-verification-2026-09-13.json) を保存しています。

## Chrome／Computer Use の制約

`cua.getState()` はアプリ一覧 14 件を返しましたが、ブラウザー一覧は空でした。同時にアプリのログには `missing-code-signing-identity` によるブラウザー／動的アプリツールの接続拒否が記録され、その後の `getApp` も `Sky Computer Use native pipe startup failed` になりました。

したがって、通常のバックエンド作業・Voice・monitor の確認とは別に、Chrome／Computer Use の接続問題は未解決です。アプリ一覧を取得できたことを、全機能が正常に動いた証拠としていません。署名チェックの回避やアプリの改変は行っていません。

## 根拠

- この App の実装 `.vite/build/src-CCXHtyvY.js` は `CODEX_CLI_PATH` を解決し、指定時はローカル daemon の再利用条件から外れます。
- [OpenAI App Server の接続プロトコル](https://learn.chatgpt.com/docs/app-server)
- [外部 CLI と Chrome／Computer Use の署名問題の報告](https://github.com/openai/codex/issues/34583)
