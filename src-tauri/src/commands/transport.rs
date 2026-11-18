//! Command group: transport.

use super::*;



#[tauri::command]
pub async fn mqtt_connect(
    state: State<'_, AppState>,
    spec: crate::service::mqtt::MqttConnectSpec,
    session_id: String,
    channel: Channel<crate::service::mqtt::MqttClientMessage>,
) -> Result<(), ErrorPayload> {
    let request_id = new_request_id();
    crate::service::mqtt::connect(&state.mqtt_sessions, spec, session_id, channel)
        .await
        .map_err(|error| ErrorPayload::new(&error, &request_id))
}

#[tauri::command]
pub async fn mqtt_subscribe(
    state: State<'_, AppState>,
    session_id: String,
    topics: Vec<crate::service::mqtt::MqttSubscription>,
) -> Result<(), ErrorPayload> {
    let request_id = new_request_id();
    crate::service::mqtt::subscribe(&state.mqtt_sessions, &session_id, topics)
        .await
        .map_err(|error| ErrorPayload::new(&error, &request_id))
}

#[tauri::command]
pub async fn mqtt_unsubscribe(
    state: State<'_, AppState>,
    session_id: String,
    topics: Vec<String>,
) -> Result<(), ErrorPayload> {
    let request_id = new_request_id();
    crate::service::mqtt::unsubscribe(&state.mqtt_sessions, &session_id, topics)
        .await
        .map_err(|error| ErrorPayload::new(&error, &request_id))
}

#[tauri::command]
pub async fn mqtt_publish(
    state: State<'_, AppState>,
    session_id: String,
    topic: String,
    payload: String,
    qos: u8,
    retain: bool,
) -> Result<(), ErrorPayload> {
    let request_id = new_request_id();
    crate::service::mqtt::publish(&state.mqtt_sessions, &session_id, topic, payload, qos, retain)
        .await
        .map_err(|error| ErrorPayload::new(&error, &request_id))
}

#[tauri::command]
pub async fn mqtt_disconnect(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), ErrorPayload> {
    let request_id = new_request_id();
    crate::service::mqtt::disconnect(&state.mqtt_sessions, &session_id)
        .await
        .map_err(|error| ErrorPayload::new(&error, &request_id))
}

#[tauri::command]
pub async fn grpc_stream_start(
    state: State<'_, AppState>,
    spec: crate::service::grpc::GrpcStreamSpec,
    session_id: String,
    channel: Channel<crate::service::grpc::GrpcStreamMessage>,
) -> Result<(), ErrorPayload> {
    let request_id = new_request_id();
    state
        .grpc_streams
        .start(state.grpc.as_ref(), session_id, spec, channel)
        .await
        .map_err(|message| ErrorPayload::new(&AppError::Grpc(message), &request_id))
}

#[tauri::command]
pub async fn grpc_stream_send(
    state: State<'_, AppState>,
    session_id: String,
    message_json: String,
) -> Result<(), ErrorPayload> {
    let request_id = new_request_id();
    state
        .grpc_streams
        .send(&session_id, &message_json)
        .await
        .map_err(|message| ErrorPayload::new(&AppError::Grpc(message), &request_id))
}

#[tauri::command]
pub async fn grpc_stream_close(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), ErrorPayload> {
    let request_id = new_request_id();
    state
        .grpc_streams
        .close(&session_id)
        .await
        .map_err(|message| ErrorPayload::new(&AppError::Grpc(message), &request_id))
}

#[tauri::command]
pub async fn grpc_stream_cancel(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), ErrorPayload> {
    let request_id = new_request_id();
    state
        .grpc_streams
        .cancel(&session_id)
        .await
        .map_err(|message| ErrorPayload::new(&AppError::Grpc(message), &request_id))
}
