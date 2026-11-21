#[cfg(not(target_os = "android"))]
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
#[cfg(not(target_os = "android"))]
use reqwest::redirect::Policy;
#[cfg(not(target_os = "android"))]
use serde::{Deserialize, Serialize};
#[cfg(not(target_os = "android"))]
use std::collections::HashMap;
#[cfg(not(target_os = "android"))]
use std::str::FromStr;
#[cfg(not(target_os = "android"))]
use std::time::Duration;

#[cfg(not(target_os = "android"))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiFetchRequest {
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    #[serde(default)]
    reject_redirects: bool,
}

#[cfg(not(target_os = "android"))]
#[derive(Debug, Serialize)]
struct ApiFetchResponse {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn api_fetch(req: ApiFetchRequest) -> Result<ApiFetchResponse, String> {
    let parsed_url = reqwest::Url::parse(&req.url).map_err(|e| format!("无效请求地址: {e}"))?;
    match parsed_url.scheme() {
        "https" => {}
        "http" if matches!(parsed_url.host_str(), Some("localhost") | Some("127.0.0.1")) => {}
        other => return Err(format!("不支持的协议: {other}")),
    }

    let policy = if req.reject_redirects {
        Policy::none()
    } else {
        Policy::limited(5)
    };

    let client = reqwest::Client::builder()
        .redirect(policy)
        .timeout(Duration::from_secs(25))
        .user_agent("CPlayer-Native/1.0 (Android; Tauri2)")
        .build()
        .map_err(|e| format!("初始化网络客户端失败: {e}"))?;

    let method = reqwest::Method::from_bytes(req.method.as_bytes())
        .map_err(|e| format!("无效 HTTP 方法: {e}"))?;

    let mut header_map = HeaderMap::new();
    for (k, v) in req.headers {
        if let (Ok(name), Ok(val)) = (HeaderName::from_str(&k), HeaderValue::from_str(&v)) {
            header_map.insert(name, val);
        }
    }

    let mut builder = client.request(method, parsed_url).headers(header_map);
    if let Some(body) = req.body {
        builder = builder.body(body);
    }

    let response = builder
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {e}"))?;

    let status = response.status().as_u16();
    if req.reject_redirects && (300..400).contains(&status) {
        return Err("已拦截非预期的重定向响应".to_string());
    }

    let mut resp_headers = HashMap::new();
    for (name, value) in response.headers().iter() {
        if let Ok(v) = value.to_str() {
            resp_headers.insert(name.as_str().to_lowercase(), v.to_string());
        }
    }

    let body = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;

    Ok(ApiFetchResponse {
        status,
        headers: resp_headers,
        body,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_haptics::init());

    #[cfg(not(target_os = "android"))]
    let builder = builder.invoke_handler(tauri::generate_handler![api_fetch]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running CPlayer Tauri application");
}
