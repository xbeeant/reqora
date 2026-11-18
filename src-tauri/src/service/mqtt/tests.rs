use super::*;

fn cfg(version: ProtocolVersion) -> ConnectConfig {
    ConnectConfig {
        version,
        client_id: "cid".into(),
        username: None,
        password: None,
        keep_alive: 60,
        clean_start: true,
    }
}

#[test]
fn remaining_length_boundaries() {
    let cases: [(usize, Vec<u8>); 6] = [
        (0, vec![0x00]),
        (127, vec![0x7F]),
        (128, vec![0x80, 0x01]),
        (16383, vec![0xFF, 0x7F]),
        (16384, vec![0x80, 0x80, 0x01]),
        (268435455, vec![0xFF, 0xFF, 0xFF, 0x7F]),
    ];
    for (value, expected) in cases {
        let encoded = encode_remaining_length(value);
        assert_eq!(encoded, expected, "value={value}");
        let (decoded, used) = decode_remaining_length(&encoded).unwrap();
        assert_eq!(decoded, value);
        assert_eq!(used, expected.len());
    }
}

#[test]
fn remaining_length_incomplete_returns_none() {
    assert_eq!(decode_remaining_length(&[]), None);
    assert_eq!(decode_remaining_length(&[0x80]), None);
    assert_eq!(decode_remaining_length(&[0x80, 0x80, 0x80, 0x80]), None);
}

#[test]
fn connect_v311_bytes_with_credentials() {
    let mut c = cfg(ProtocolVersion::V311);
    c.client_id = "cid".into();
    c.username = Some("user".into());
    c.password = Some("pass".into());
    let bytes = encode_connect(&c);
    assert_eq!(bytes[0], 0x10);
    assert_eq!(bytes[1], 0x1B); // 27 字节 body，单字节 remaining length
    let body = &bytes[2..];
    assert_eq!(&body[0..6], b"\x00\x04MQTT");
    assert_eq!(body[6], 4); // level 4
    assert_eq!(body[7], 0xC2); // username | password | clean session
    assert_eq!(&body[8..10], &60u16.to_be_bytes());
    assert_eq!(&body[10..12], &3u16.to_be_bytes());
    assert_eq!(&body[12..15], b"cid");
    assert_eq!(&body[15..17], &4u16.to_be_bytes());
    assert_eq!(&body[17..21], b"user");
    assert_eq!(&body[21..23], &4u16.to_be_bytes());
    assert_eq!(&body[23..27], b"pass");
}

#[test]
fn connect_v5_has_level5_and_empty_properties() {
    let mut c = cfg(ProtocolVersion::V5);
    c.keep_alive = 30;
    let bytes = encode_connect(&c);
    assert_eq!(bytes[0], 0x10);
    assert_eq!(bytes[1], 0x10); // 16 字节 body
    let body = &bytes[2..];
    assert_eq!(&body[0..6], b"\x00\x04MQTT");
    assert_eq!(body[6], 5); // level 5
    assert_eq!(body[7], 0x02); // clean start
    assert_eq!(&body[8..10], &30u16.to_be_bytes());
    assert_eq!(body[10], 0x00); // properties 长度 0
    assert_eq!(&body[11..13], &3u16.to_be_bytes());
    assert_eq!(&body[13..16], b"cid");
}

#[test]
fn connect_without_credentials_has_no_flags() {
    let mut c = cfg(ProtocolVersion::V311);
    c.clean_start = false;
    c.keep_alive = 0;
    let bytes = encode_connect(&c);
    let body = &bytes[2..];
    assert_eq!(body[7], 0x00);
    assert_eq!(&body[8..10], &0u16.to_be_bytes());
    assert_eq!(body.len(), 15); // 6(name)+1(level)+1(flags)+2(keepalive)+5(client id)
}

#[test]
fn publish_qos0_roundtrip() {
    let pkt = encode_publish("a/b", b"hello", 0, false, false, None, ProtocolVersion::V311);
    assert_eq!(pkt[0], 0x30);
    let (rl, used) = decode_remaining_length(&pkt[1..]).unwrap();
    assert_eq!(1 + used + rl, pkt.len());
    let dec = decode_publish(pkt[0], &pkt[1 + used..], ProtocolVersion::V311).unwrap();
    assert_eq!(dec.topic, "a/b");
    assert_eq!(dec.payload, b"hello".to_vec());
    assert_eq!(dec.qos, 0);
    assert!(!dec.retain);
    assert_eq!(dec.packet_id, None);
}

#[test]
fn publish_qos1_roundtrip_and_puback() {
    let pkt = encode_publish(
        "t",
        b"data",
        1,
        true,
        false,
        Some(7),
        ProtocolVersion::V311,
    );
    assert_eq!(pkt[0], 0x33); // qos1 + retain
    let (_, used) = decode_remaining_length(&pkt[1..]).unwrap();
    let dec = decode_publish(pkt[0], &pkt[1 + used..], ProtocolVersion::V311).unwrap();
    assert_eq!(dec.qos, 1);
    assert!(dec.retain);
    assert_eq!(dec.packet_id, Some(7));
    assert_eq!(dec.payload, b"data".to_vec());
    assert_eq!(encode_puback(7, ProtocolVersion::V311), vec![0x40, 0x02, 0x00, 0x07]);
}

#[test]
fn publish_v5_carries_empty_properties() {
    let pkt = encode_publish("t", b"x", 1, false, false, Some(1), ProtocolVersion::V5);
    let (_, used) = decode_remaining_length(&pkt[1..]).unwrap();
    let body = &pkt[1 + used..];
    assert_eq!(&body[0..2], &1u16.to_be_bytes()); // topic 长度
    assert_eq!(body[2], b't');
    assert_eq!(&body[3..5], &1u16.to_be_bytes()); // packet id
    assert_eq!(body[5], 0x00); // properties 长度 0
    assert_eq!(body[6], b'x'); // payload
    let dec = decode_publish(pkt[0], body, ProtocolVersion::V5).unwrap();
    assert_eq!(dec.payload, b"x".to_vec());
}

#[test]
fn publish_qos3_is_rejected() {
    assert!(decode_publish(0x36, &[], ProtocolVersion::V311).is_err());
}

#[test]
fn topic_matches_single_level_wildcard() {
    assert!(topic_matches("sport/+/player1", "sport/tennis/player1"));
    assert!(!topic_matches("sport/+/player1", "sport/tennis/ranking/player1"));
    assert!(topic_matches("+/+", "/finance"));
    assert!(!topic_matches("+/+", "/finance/usa"));
}

#[test]
fn topic_matches_multi_level_wildcard_and_system_topics() {
    assert!(topic_matches("#", "a/b/c"));
    assert!(topic_matches("sport/#", "sport")); // 匹配父级
    assert!(topic_matches("sport/#", "sport/tennis/player1"));
    assert!(!topic_matches("sport/#", "other"));
    assert!(!topic_matches("#/x", "a/x")); // # 非最后一层
    assert!(topic_matches("a/b", "a/b"));
    assert!(!topic_matches("a/b", "a/c"));
    assert!(!topic_matches("#", "$SYS/broker")); // 通配不匹配 $ 系统主题
    assert!(topic_matches("$SYS/#", "$SYS/broker"));
}

#[test]
fn subscribe_suback_roundtrip() {
    let topics = vec![("a/b".to_string(), 1u8), ("c/+".to_string(), 2u8)];
    let pkt = encode_subscribe(9, &topics, ProtocolVersion::V311);
    assert_eq!(pkt[0], 0x82);
    let (rl, used) = decode_remaining_length(&pkt[1..]).unwrap();
    assert_eq!(1 + used + rl, pkt.len());
    let body = &pkt[1 + used..];
    assert_eq!(&body[0..2], &9u16.to_be_bytes());

    let suback = vec![0x90, 0x04, 0x00, 0x09, 0x01, 0x02];
    let (_, used2) = decode_remaining_length(&suback[1..]).unwrap();
    let (pid, codes) =
        decode_suback(&suback[1 + used2..], ProtocolVersion::V311).unwrap();
    assert_eq!(pid, 9);
    assert_eq!(codes, vec![1, 2]);
}

#[test]
fn unsubscribe_unsuback_roundtrip() {
    let topics = vec!["a/b".to_string(), "c/+".to_string()];
    let pkt = encode_unsubscribe(5, &topics, ProtocolVersion::V311);
    assert_eq!(pkt[0], 0xA2);
    let unsuback = vec![0xB0, 0x02, 0x00, 0x05];
    let (_, used) = decode_remaining_length(&unsuback[1..]).unwrap();
    assert_eq!(decode_unsuback(&unsuback[1 + used..]).unwrap(), 5);
}

#[test]
fn pingreq_and_v5_acks_and_disconnect() {
    assert_eq!(encode_pingreq(), vec![0xC0, 0x00]);
    assert_eq!(
        encode_puback(9, ProtocolVersion::V5),
        vec![0x40, 0x04, 0x00, 0x09, 0x00, 0x00]
    );
    assert_eq!(encode_disconnect(ProtocolVersion::V5), vec![0xE0, 0x02, 0x00, 0x00]);
    assert_eq!(encode_disconnect(ProtocolVersion::V311), vec![0xE0, 0x00]);
}

#[test]
fn frame_accumulator_handles_fragmented_input() {
    let frame = encode_publish("t", b"hello", 0, false, false, None, ProtocolVersion::V311);
    let mut all = frame.clone();
    all.extend_from_slice(&[0xD0, 0x00]); // PINGRESP 作为第二帧

    let mut acc = FrameAccumulator::new();
    let mut got = Vec::new();
    // 逐字节喂入，模拟最碎的分片
    for &byte in &all {
        acc.push(&[byte]);
        while let Some(f) = acc.pop() {
            got.push(f);
        }
    }
    assert_eq!(got.len(), 2);
    assert_eq!(packet_type(got[0].header), 3); // PUBLISH
    let dec = decode_publish(got[0].header, &got[0].remaining, ProtocolVersion::V311).unwrap();
    assert_eq!(dec.topic, "t");
    assert_eq!(dec.payload, b"hello".to_vec());
    assert_eq!(packet_type(got[1].header), 13); // PINGRESP
    assert!(got[1].remaining.is_empty());
}

#[test]
fn frame_accumulator_multiple_frames_single_push() {
    let mut all = encode_pingreq();
    all.extend_from_slice(&[0xD0, 0x00]);
    let mut acc = FrameAccumulator::new();
    acc.push(&all);
    let mut types = Vec::new();
    while let Some(f) = acc.pop() {
        types.push(packet_type(f.header));
    }
    assert_eq!(types, vec![12, 13]);
}

#[test]
fn connack_reject_codes() {
    let ok = MqttFrame {
        header: 0x20,
        remaining: vec![0x00, 0x00],
    };
    assert!(validate_connack(&ok, ProtocolVersion::V311).is_ok());

    let rejected = MqttFrame {
        header: 0x20,
        remaining: vec![0x00, 0x05],
    };
    let err = validate_connack(&rejected, ProtocolVersion::V311).unwrap_err();
    assert!(err.contains("拒绝"));

    let v5ok = MqttFrame {
        header: 0x20,
        remaining: vec![0x00, 0x00, 0x00],
    };
    assert!(validate_connack(&v5ok, ProtocolVersion::V5).is_ok());

    let v5bad = MqttFrame {
        header: 0x20,
        remaining: vec![0x00, 0x87, 0x00],
    };
    assert!(validate_connack(&v5bad, ProtocolVersion::V5).is_err());
}

#[test]
fn packet_id_wraps() {
    assert_eq!(next_packet_id(0), 1);
    assert_eq!(next_packet_id(1), 2);
    assert_eq!(next_packet_id(65534), 65535);
    assert_eq!(next_packet_id(65535), 1);
}
