//! Command group: update.

use super::*;



#[tauri::command]
pub async fn check_update(
    state: State<'_, AppState>,
    endpoint: Option<String>,
) -> Result<reqora_core::service::update::UpdateCheckResult, ErrorPayload> {
    let request_id = new_request_id();
    let manifest_url = endpoint
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| state.config.update_manifest_url.clone());

    // A per-call endpoint override is still an IPC input: it may point at a
    // different host, but it may not downgrade the transport. The signature
    // check that follows is the actual trust root.
    if let Some(ref url) = manifest_url {
        let allowed = reqwest::Url::parse(url)
            .map(|parsed| reqora_core::trust::manifest_url_allowed(&parsed))
            .unwrap_or(false);
        if !allowed {
            return Err(ErrorPayload::new(
                &AppError::Network("更新清单地址必须使用 HTTPS（仅本机回环地址允许 HTTP）".into()),
                &request_id,
            ));
        }
    }

    if let Some(ref url) = manifest_url {
        log(
            LogLevel::Info,
            "update.check",
            &request_id,
            json!({
                "endpointHost": reqwest::Url::parse(url)
                    .ok()
                    .and_then(|url| url.host_str().map(|host| host.to_string())),
                "verifyTls": state.config.update_verify_tls,
            }),
            state.config.log_level,
        );
    }

    let log_level = state.config.log_level;
    let result = match &manifest_url {
        Some(url) => {
            reqora_core::service::update::check_update(
                url,
                &state.config.update_public_key,
                state.config.update_verify_tls,
            )
            .await
        }
        None => Ok(reqora_core::service::update::UpdateCheckResult {
            current_version: reqora_core::service::update::CURRENT_VERSION.to_string(),
            latest_version: reqora_core::service::update::CURRENT_VERSION.to_string(),
            has_update: false,
            download_url: None,
            notes: None,
            pub_date: None,
            signature_verified: false,
        }),
    };
    match &result {
        Ok(outcome) => log(
            LogLevel::Info,
            "update.check.done",
            &request_id,
            json!({
                "current": outcome.current_version,
                "latest": outcome.latest_version,
                "hasUpdate": outcome.has_update,
                "downloadUrl": outcome.download_url,
            }),
            log_level,
        ),
        Err(message) => log(
            LogLevel::Warn,
            "update.check.failed",
            &request_id,
            json!({ "reason": message }),
            log_level,
        ),
    }
    result.map_err(|message| ErrorPayload::new(&AppError::Network(message), &request_id))
}

fn oauth2_config_from_value(value: &Value) -> Result<reqora_core::service::auth::OAuth2Config, AppError> {
    let field = |key: &str| -> Option<String> {
        value
            .get(key)
            .and_then(|item| item.as_str())
            .map(ToOwned::to_owned)
    };
    Ok(reqora_core::service::auth::OAuth2Config {
        grant: field("grant").unwrap_or_else(|| "authorizationCode".into()),
        token_url: field("tokenUrl"),
        auth_url: field("authUrl"),
        client_id: field("clientId"),
        client_secret: field("clientSecret"),
        scope: field("scope"),
        audience: field("audience"),
        redirect_uri: field("redirectUri"),
        username: field("username"),
        password: field("password"),
        code: field("code"),
        code_verifier: field("codeVerifier"),
        access_token: field("accessToken"),
        refresh_token: field("refreshToken"),
        token_type: field("tokenType"),
        expires_at: value.get("expiresAt").and_then(|item| item.as_i64()),
        token_prefix: field("tokenPrefix"),
        client_auth: field("clientAuth"),
    })
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = &input[index + 1..index + 3];
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                out.push(value);
                index += 3;
                continue;
            }
        }
        if bytes[index] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[index]);
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query_value(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let mut parts = pair.splitn(2, '=');
        let name = parts.next()?;
        let value = parts.next().unwrap_or("");
        (name == key).then(|| percent_decode(value))
    })
}

fn oauth2_token_json(token: &reqora_core::service::auth::OAuth2TokenState) -> Value {
    json!({
        "accessToken": token.access_token,
        "refreshToken": token.refresh_token,
        "tokenType": token.token_type,
        "expiresAt": token.expires_at,
    })
}

/// Authorization-code + PKCE needs a loopback redirect. Spawn a one-shot
/// listener, open the system browser and exchange the code as soon as the
/// provider calls back. Everything stays on 127.0.0.1; no secret is logged.
async fn oauth2_local_callback(
    cfg: &reqora_core::service::auth::OAuth2Config,
) -> Result<reqora_core::service::auth::OAuth2TokenState, AppError> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (verifier, challenge) = reqora_core::service::auth::pkce_pair();
    let state_token = uuid::Uuid::new_v4().to_string();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| AppError::Network(format!("本地回调服务启动失败：{error}")))?;
    let port = listener
        .local_addr()
        .map_err(|error| AppError::Network(format!("本地回调地址读取失败：{error}")))?
        .port();

    let mut cfg = cfg.clone();
    cfg.redirect_uri = Some(format!("http://127.0.0.1:{port}/callback"));
    let authorize =
        reqora_core::service::auth::authorize_url(&cfg, &state_token, Some(&challenge))?;
    let browser_url = authorize.clone();
    tokio::task::spawn_blocking(move || {
        let _ = open::that(browser_url);
    });

    let accepted = tokio::time::timeout(Duration::from_secs(180), listener.accept())
        .await
        .map_err(|_| AppError::Timeout)?
        .map_err(|error| AppError::Network(format!("本地回调接收失败：{error}")))?;
    let (mut socket, _) = accepted;
    let mut buffer = [0u8; 8192];
    let count = tokio::time::timeout(Duration::from_secs(10), socket.read(&mut buffer))
        .await
        .map_err(|_| AppError::Timeout)?
        .map_err(|error| AppError::Network(format!("本地回调读取失败：{error}")))?;
    let request = String::from_utf8_lossy(&buffer[..count]);
    let target = request.split_whitespace().nth(1).unwrap_or("");
    let query = target.split_once('?').map(|(_, rest)| rest).unwrap_or("");
    let returned_state = query_value(query, "state").unwrap_or_default();
    let code = query_value(query, "code").unwrap_or_default();
    let error = query_value(query, "error");

    let body = if error.is_none()
        && !code.is_empty()
        && (returned_state.is_empty() || returned_state == state_token)
    {
        "<html><body><h2>授权成功</h2><p>可以返回 Reqora 继续操作。</p></body></html>"
    } else {
        "<html><body><h2>授权失败</h2><p>请返回 Reqora 检查授权参数。</p></body></html>"
    };
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.shutdown().await;

    if let Some(reason) = error {
        return Err(AppError::InvalidInput(format!("授权服务器返回错误：{reason}")));
    }
    if code.is_empty() || (!returned_state.is_empty() && returned_state != state_token) {
        return Err(AppError::InvalidInput("授权码缺失或 state 校验失败".into()));
    }
    cfg.code = Some(code.clone());
    cfg.code_verifier = Some(verifier.clone());
    reqora_core::service::auth::exchange_code(&cfg, &code, Some(&verifier)).await
}

#[tauri::command]
pub async fn oauth2_authorize(
    _state: State<'_, AppState>,
    config: Value,
) -> Result<Value, ErrorPayload> {
    let request_id = new_request_id();
    let result = async {
        let cfg = oauth2_config_from_value(&config)?;
        let has_code = cfg
            .code
            .as_deref()
            .map(|item| !item.trim().is_empty())
            .unwrap_or(false);
        if cfg.grant == "authorizationCode" && !has_code {
            let token = oauth2_local_callback(&cfg).await?;
            Ok::<Value, AppError>(oauth2_token_json(&token))
        } else {
            let outcome = reqora_core::service::auth::oauth2_outcome(&cfg).await?;
            let token = outcome
                .oauth2
                .ok_or_else(|| AppError::InvalidInput("未获取到访问令牌".into()))?;
            Ok(oauth2_token_json(&token))
        }
    }
    .await;
    result.map_err(|error| ErrorPayload::new(&error, &request_id))
}
