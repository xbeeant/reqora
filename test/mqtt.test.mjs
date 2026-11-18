import assert from "node:assert/strict";
import test from "node:test";
import {
  MQTT_CONTROL_TYPES,
  MqttPacketParser,
  decodeConnack,
  decodePublish,
  decodeRemainingLength,
  decodeSuback,
  encodeConnect,
  encodeDisconnect,
  encodePingreq,
  encodePuback,
  encodePublish,
  encodeRemainingLength,
  encodeSubscribe,
  encodeUnsubscribe,
  encodeUtf,
  parseMqttUrl,
  topicMatches,
} from "../src/lib/mqtt.ts";

const u8 = (...bytes) => new Uint8Array(bytes);
const arr = (bytes) => Array.from(bytes);
const join = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
/** 取编码器输出报文的「报文体」（去掉固定头 + 剩余长度） */
const bodyOf = (packet) => new MqttPacketParser().push(packet)[0].payload;

test("01 remaining length 边界值与 VBI 编解码往返", () => {
  const cases = [
    [0, [0x00]],
    [127, [0x7f]],
    [128, [0x80, 0x01]],
    [16383, [0xff, 0x7f]],
    [16384, [0x80, 0x80, 0x01]],
    [268435455, [0xff, 0xff, 0xff, 0x7f]],
  ];
  for (const [value, expected] of cases) {
    assert.deepEqual(arr(encodeRemainingLength(value)), expected);
    assert.deepEqual(decodeRemainingLength(u8(...expected, 0xaa)), [value, expected.length]);
  }
});

test("02 remaining length 非法输入与畸形数据抛错", () => {
  assert.throws(() => encodeRemainingLength(268435456), RangeError);
  assert.throws(() => encodeRemainingLength(-1), RangeError);
  assert.throws(() => encodeRemainingLength(1.5), RangeError);
  assert.throws(() => encodeRemainingLength(Infinity), RangeError);
  assert.throws(() => decodeRemainingLength(u8(0x80))); // 数据不足
  assert.throws(() => decodeRemainingLength(u8(0xff, 0xff, 0xff, 0xff))); // 超过 4 字节
  assert.throws(() => decodeRemainingLength(u8(0x00), 1)); // offset 越界
  assert.throws(() => decodeRemainingLength(u8()));
});

test("03 decodeRemainingLength 支持 offset", () => {
  assert.deepEqual(decodeRemainingLength(u8(0xaa, 0x80, 0x01, 0xbb), 1), [128, 3]);
  assert.deepEqual(decodeRemainingLength(u8(0x00)), [0, 1]);
});

test("04 encodeUtf：2 字节长度前缀、空串与多字节字符", () => {
  assert.deepEqual(arr(encodeUtf("hi")), [0, 2, 0x68, 0x69]);
  assert.deepEqual(arr(encodeUtf("")), [0, 0]);
  assert.deepEqual(arr(encodeUtf("中")), [0, 3, 0xe4, 0xb8, 0xad]);
  assert.throws(() => encodeUtf("a".repeat(65536)), RangeError);
});

test("05 3.1.1 CONNECT 手工字节序列（0x10 / MQTT / level 4 / clean session）", () => {
  const bytes = encodeConnect({
    clientId: "cid",
    keepAliveSecs: 60,
    cleanSession: true,
    version: "3.1.1",
  });
  assert.deepEqual(arr(bytes), [
    0x10, 0x0f, 0x00, 0x04, 0x4d, 0x51, 0x54, 0x54,
    0x04, 0x02, 0x00, 0x3c, 0x00, 0x03, 0x63, 0x69, 0x64,
  ]);
  assert.equal(bytes[0], 0x10);
  assert.equal(new TextDecoder().decode(bytes.subarray(4, 8)), "MQTT");
  assert.equal(bytes[8], 4);
  assert.equal(bytes[9], 0x02);
});

test("06 CONNECT flags 与 will / 用户名 / 密码载荷顺序", () => {
  const bytes = encodeConnect({
    clientId: "c",
    username: "u",
    password: "p",
    will: { topic: "w/t", payload: "bye", qos: 1, retain: true },
    cleanSession: true,
    keepAliveSecs: 10,
    version: "3.1.1",
  });
  assert.deepEqual(arr(bytes), [
    0x10, 0x1d, 0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04,
    0xee, 0x00, 0x0a,
    0x00, 0x01, 0x63,
    0x00, 0x03, 0x77, 0x2f, 0x74,
    0x00, 0x03, 0x62, 0x79, 0x65,
    0x00, 0x01, 0x75,
    0x00, 0x01, 0x70,
  ]);
  assert.equal(bytes[9] & 0x02, 0x02); // clean session
  assert.equal(bytes[9] & 0x04, 0x04); // will flag
  assert.equal((bytes[9] >> 3) & 0x03, 1); // will qos
  assert.equal(bytes[9] & 0x20, 0x20); // will retain
  assert.equal(bytes[9] & 0xc0, 0xc0); // username + password

  const noClean = encodeConnect({ clientId: "c", cleanSession: false, keepAliveSecs: 0 });
  assert.equal(noClean[9], 0x00);
});

test("07 5.0 CONNECT：level=5 且 properties length=0 位于 keepAlive 之后", () => {
  const bytes = encodeConnect({
    clientId: "cid",
    version: "5",
    keepAliveSecs: 0,
    cleanSession: false,
  });
  assert.deepEqual(arr(bytes), [
    0x10, 0x10, 0x00, 0x04, 0x4d, 0x51, 0x54, 0x54,
    0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x63, 0x69, 0x64,
  ]);
  assert.equal(bytes[8], 5); // protocol level
  assert.equal(bytes[12], 0); // properties length = 0
  assert.deepEqual(arr(bytes.subarray(13)), [0x00, 0x03, 0x63, 0x69, 0x64]); // client id 紧随其后
});

test("08 手工构造 3.1 风格 MQIsdp 报文可被增量 parser 识别", () => {
  const legacy = u8(
    0x10, 0x0f, 0x00, 0x06, 0x4d, 0x51, 0x49, 0x73, 0x64, 0x70,
    0x03, 0x02, 0x00, 0x3c, 0x00, 0x01, 0x63,
  );
  const packets = new MqttPacketParser().push(legacy);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].type, 1);
  assert.equal(packets[0].flags, 0);
  assert.deepEqual(arr(packets[0].payload.subarray(0, 8)), [
    0x00, 0x06, 0x4d, 0x51, 0x49, 0x73, 0x64, 0x70,
  ]);
});

test("09 decodeConnack 3.1.1：session present 与 return code", () => {
  assert.deepEqual(decodeConnack(u8(0x01, 0x00)), { sessionPresent: true, returnCode: 0 });
  assert.deepEqual(decodeConnack(u8(0x00, 0x05)), { sessionPresent: false, returnCode: 5 });
  assert.deepEqual(decodeConnack(u8(0x01, 0x00), "3.1.1"), {
    sessionPresent: true,
    returnCode: 0,
  });
});

test("10 decodeConnack 5.0：reason code 与 properties 兼容", () => {
  assert.deepEqual(decodeConnack(u8(0x01, 0x00, 0x00), "5"), {
    sessionPresent: true,
    returnCode: 0,
    reasonCode: 0,
  });
  assert.deepEqual(decodeConnack(u8(0x00, 0x85, 0x03, 0x11, 0x22, 0x33), "5"), {
    sessionPresent: false,
    returnCode: 0x85,
    reasonCode: 0x85,
  });
});

test("11 encodeSubscribe 3.1.1 手工字节序列（0x82 / packet id / options）", () => {
  const bytes = encodeSubscribe(1, [
    { topic: "a", qos: 0 },
    { topic: "b/c", qos: 1 },
  ]);
  assert.deepEqual(arr(bytes), [
    0x82, 0x0c, 0x00, 0x01, 0x00, 0x01, 0x61, 0x00, 0x00, 0x03, 0x62, 0x2f, 0x63, 0x01,
  ]);
  assert.equal(bytes[0], 0x82);
  assert.equal(bytes[7], 0); // 第一个订阅的 QoS
  assert.equal(bytes[13], 1); // 第二个订阅的 QoS
});

test("12 5.0 SUBSCRIBE：properties length=0 位于 packet id 之前", () => {
  const bytes = encodeSubscribe(1, [{ topic: "a", qos: 0 }], "5");
  assert.deepEqual(arr(bytes), [0x82, 0x07, 0x00, 0x00, 0x01, 0x00, 0x01, 0x61, 0x00]);
  assert.equal(bytes[2], 0x00); // properties length
  assert.deepEqual(arr(bytes.subarray(3, 5)), [0x00, 0x01]); // packet id
});

test("13 encodeUnsubscribe 3.1.1 / 5.0 手工字节序列", () => {
  assert.deepEqual(arr(encodeUnsubscribe(7, ["a", "b/c"])), [
    0xa2, 0x0a, 0x00, 0x07, 0x00, 0x01, 0x61, 0x00, 0x03, 0x62, 0x2f, 0x63,
  ]);
  const v5 = encodeUnsubscribe(7, ["a", "b/c"], "5");
  assert.deepEqual(arr(v5), [
    0xa2, 0x0b, 0x00, 0x00, 0x07, 0x00, 0x01, 0x61, 0x00, 0x03, 0x62, 0x2f, 0x63,
  ]);
  assert.equal(v5[2], 0x00); // properties length 在 packet id 之前
});

test("14 decodeSuback 3.1.1 返回 return codes", () => {
  assert.deepEqual(decodeSuback(u8(0x00, 0x01, 0x00, 0x01, 0x80)), [0, 1, 0x80]);
  assert.deepEqual(decodeSuback(u8(0x00, 0x01)), []);
});

test("15 decodeSuback 5.0 跳过 properties", () => {
  assert.deepEqual(decodeSuback(u8(0x00, 0x01, 0x00, 0x00, 0x01, 0x80), "5"), [0, 1, 0x80]);
  assert.deepEqual(decodeSuback(u8(0x00, 0x01, 0x02, 0x11, 0x22, 0x00, 0x02), "5"), [0, 2]);
});

test("16 encodePublish qos0 手工字节序列", () => {
  assert.deepEqual(arr(encodePublish({ topic: "a/b", payload: "hi" })), [
    0x30, 0x07, 0x00, 0x03, 0x61, 0x2f, 0x62, 0x68, 0x69,
  ]);
  assert.deepEqual(arr(encodePublish({ topic: "t", payload: u8(0x00, 0xff) })), [
    0x30, 0x05, 0x00, 0x01, 0x74, 0x00, 0xff,
  ]);
});

test("17 encodePublish qos1 / dup / retain 手工字节序列", () => {
  assert.deepEqual(arr(encodePublish({ topic: "t", payload: "x", qos: 1, packetId: 7 })), [
    0x32, 0x06, 0x00, 0x01, 0x74, 0x00, 0x07, 0x78,
  ]);
  assert.deepEqual(
    arr(encodePublish({ topic: "t", payload: "x", qos: 1, packetId: 7, dup: true, retain: true })),
    [0x3b, 0x06, 0x00, 0x01, 0x74, 0x00, 0x07, 0x78],
  );
});

test("18 5.0 PUBLISH：properties length=0 位于 topic 之后", () => {
  assert.deepEqual(arr(encodePublish({ topic: "t", payload: "x", version: "5" })), [
    0x30, 0x05, 0x00, 0x01, 0x74, 0x00, 0x78,
  ]);
  assert.deepEqual(
    arr(encodePublish({ topic: "t", payload: "x", qos: 1, packetId: 7, version: "5" })),
    [0x32, 0x07, 0x00, 0x01, 0x74, 0x00, 0x00, 0x07, 0x78],
  );
});

test("19 decodePublish 编解码往返（3.1.1 / 5.0、qos0 / qos1 / qos2）", () => {
  assert.deepEqual(decodePublish(bodyOf(encodePublish({ topic: "a/b", payload: "hello 中" })), 0), {
    topic: "a/b",
    payload: "hello 中",
  });
  assert.deepEqual(
    decodePublish(bodyOf(encodePublish({ topic: "t", payload: "x", qos: 1, packetId: 0x1234 })), 1),
    { topic: "t", payload: "x", packetId: 0x1234 },
  );
  assert.deepEqual(
    decodePublish(bodyOf(encodePublish({ topic: "t", payload: "x", version: "5" })), 0, "5"),
    { topic: "t", payload: "x", propertiesLength: 0 },
  );
  assert.deepEqual(
    decodePublish(
      bodyOf(encodePublish({ topic: "t", payload: "x", qos: 2, packetId: 9, version: "5" })),
      2,
      "5",
    ),
    { topic: "t", payload: "x", packetId: 9, propertiesLength: 0 },
  );
});

test("20 encodePuback 3.1.1 / 5.0", () => {
  assert.deepEqual(arr(encodePuback(7)), [0x40, 0x02, 0x00, 0x07]);
  assert.deepEqual(arr(encodePuback(7, "5")), [0x40, 0x03, 0x00, 0x07, 0x00]);
});

test("21 PINGREQ / DISCONNECT 手工字节序列", () => {
  assert.deepEqual(arr(encodePingreq()), [0xc0, 0x00]);
  assert.deepEqual(arr(encodeDisconnect()), [0xe0, 0x00]);
  assert.deepEqual(arr(encodeDisconnect("3.1.1")), [0xe0, 0x00]);
  assert.deepEqual(arr(encodeDisconnect("5")), [0xe0, 0x01, 0x00]);
});

test("22 topicMatches 表驱动：+ / # / $ 系统主题 / 空层级 / 非法通配", () => {
  const cases = [
    ["finance", "finance", true],
    ["finance", "finance/stock", false],
    ["sport/tennis/player1/#", "sport/tennis/player1", true],
    ["sport/tennis/player1/#", "sport/tennis/player1/ranking", true],
    ["sport/tennis/player1/#", "sport/tennis/player1/ranking/atp", true],
    ["sport/#", "sport", true],
    ["sport/#", "sport/tennis", true],
    ["sport/#", "sportX/tennis", false],
    ["#", "a/b/c", true],
    ["#", "$SYS/foo", false],
    ["+", "$SYS", false],
    ["+/monitor/Clients", "$SYS/monitor/Clients", false],
    ["$SYS/#", "$SYS/monitor/Clients", true],
    ["$SYS/#", "$SYS", true],
    ["sport/+/player1", "sport/tennis/player1", true],
    ["sport/+/player1", "sport/tennis/player2", false],
    ["sport/+/player1", "sport/tennis/rugby/player1", false],
    ["+/tennis/#", "sport/tennis/player1", true],
    ["+/tennis/#", "sport/tennis", true],
    ["sport/tennis/+", "sport/tennis", false],
    ["a//b", "a//b", true],
    ["a/+/b", "a//b", true],
    ["a/+/b", "a/x/b", true],
    ["a/+/b", "a/x/y/b", false],
    ["sport/tennis#", "sport/tennis", false],
    ["sport/tennis/player1#", "sport/tennis/player1", false],
    ["sport/+x", "sport/tennis", false],
    ["sport/#/ranking", "sport/tennis/ranking", false],
    ["#/ranking", "a/ranking", false],
    ["", "", false],
  ];
  for (const [filter, topic, expected] of cases) {
    assert.equal(topicMatches(filter, topic), expected, `${filter} vs ${topic}`);
  }
});

test("23 parseMqttUrl：四种 scheme、默认端口、显式端口、path 与凭据", () => {
  assert.deepEqual(parseMqttUrl("mqtt://broker.example.com"), {
    host: "broker.example.com",
    port: 1883,
    useTls: false,
    transport: "tcp",
  });
  assert.deepEqual(parseMqttUrl("mqtts://broker.example.com:8884"), {
    host: "broker.example.com",
    port: 8884,
    useTls: true,
    transport: "tcp",
  });
  assert.deepEqual(parseMqttUrl("ws://broker.example.com/mqtt"), {
    host: "broker.example.com",
    port: 80,
    useTls: false,
    transport: "ws",
    path: "/mqtt",
  });
  assert.deepEqual(parseMqttUrl("wss://broker.example.com/mqtt"), {
    host: "broker.example.com",
    port: 443,
    useTls: true,
    transport: "ws",
    path: "/mqtt",
  });
  assert.deepEqual(parseMqttUrl("ws://broker.example.com:8080/mqtt?x=1"), {
    host: "broker.example.com",
    port: 8080,
    useTls: false,
    transport: "ws",
    path: "/mqtt?x=1",
  });
  const creds = parseMqttUrl("mqtt://user:p%40ss@broker.example.com:1883");
  assert.equal(creds.host, "broker.example.com");
  assert.equal(creds.port, 1883);
  assert.equal(creds.username, "user");
  assert.equal(creds.password, "p@ss"); // 只断言，不打印
  assert.throws(() => parseMqttUrl("http://broker.example.com"));
  assert.throws(() => parseMqttUrl("not-a-url"));
});

test("24 MqttPacketParser 单个 chunk 内含多个报文", () => {
  const stream = join(
    encodePingreq(),
    u8(0xd0, 0x00), // PINGRESP
    encodeDisconnect(),
    encodePublish({ topic: "a", payload: "x" }),
  );
  const packets = new MqttPacketParser().push(stream);
  assert.equal(packets.length, 4);
  assert.deepEqual(packets.map((p) => [p.type, p.flags]), [
    [12, 0],
    [13, 0],
    [14, 0],
    [3, 0],
  ]);
  assert.equal(packets[3].payload.length, 4);
  assert.deepEqual(arr(packets[3].payload), [0x00, 0x01, 0x61, 0x78]);
});

test("25 MqttPacketParser 逐字节分片喂入且不提前吐包", () => {
  const parser = new MqttPacketParser();
  const stream = join(
    encodePingreq(),
    encodePublish({ topic: "a/b", payload: "hi" }),
    encodeDisconnect("5"),
  );
  const all = [];
  for (const byte of stream) {
    for (const packet of parser.push(u8(byte))) all.push(packet);
  }
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((p) => p.type), [12, 3, 14]);

  const partial = new MqttPacketParser();
  assert.deepEqual(partial.push(u8(0xc0)), []);
  assert.equal(partial.push(u8(0x00)).length, 1);
  assert.deepEqual(partial.push(u8()), []);
});

test("26 MqttPacketParser 多字节 remaining length 跨 chunk 拼接", () => {
  const body = new Uint8Array(130);
  for (let i = 0; i < body.length; i++) body[i] = i & 0xff;
  const packet = join(u8(0x30), encodeRemainingLength(body.length), body);
  assert.deepEqual(arr(packet.subarray(0, 3)), [0x30, 0x82, 0x01]);

  const parser = new MqttPacketParser();
  assert.deepEqual(parser.push(packet.subarray(0, 1)), []);
  assert.deepEqual(parser.push(packet.subarray(1, 2)), []);
  assert.deepEqual(parser.push(packet.subarray(2, 10)), []);
  const out = parser.push(packet.subarray(10));
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 3);
  assert.deepEqual(arr(out[0].payload), arr(body));
});

test("27 MQTT_CONTROL_TYPES 常量", () => {
  assert.equal(MQTT_CONTROL_TYPES.CONNECT, 1);
  assert.equal(MQTT_CONTROL_TYPES.CONNACK, 2);
  assert.equal(MQTT_CONTROL_TYPES.PUBLISH, 3);
  assert.equal(MQTT_CONTROL_TYPES.PUBACK, 4);
  assert.equal(MQTT_CONTROL_TYPES.SUBSCRIBE, 8);
  assert.equal(MQTT_CONTROL_TYPES.SUBACK, 9);
  assert.equal(MQTT_CONTROL_TYPES.UNSUBSCRIBE, 10);
  assert.equal(MQTT_CONTROL_TYPES.PINGREQ, 12);
  assert.equal(MQTT_CONTROL_TYPES.DISCONNECT, 14);
  assert.equal(Object.keys(MQTT_CONTROL_TYPES).length, 14);
});

test("28 parser + decode 组合往返（CONNECT/CONNACK/SUBSCRIBE/SUBACK/PUBLISH）", () => {
  const stream = join(
    encodeConnect({ clientId: "c", version: "5" }),
    u8(0x20, 0x02, 0x01, 0x00), // CONNACK sessionPresent=1
    encodeSubscribe(5, [{ topic: "a/#", qos: 1 }], "5"),
    u8(0x90, 0x05, 0x00, 0x05, 0x00, 0x00, 0x01), // SUBACK 5.0: pid 5, props 0, codes [0,1]
    encodePublish({ topic: "t", payload: "v", qos: 1, packetId: 9, version: "5" }),
  );
  const packets = new MqttPacketParser().push(stream);
  assert.equal(packets.length, 5);
  assert.deepEqual(packets.map((p) => p.type), [1, 2, 8, 9, 3]);
  assert.deepEqual(decodeConnack(packets[1].payload, "5"), {
    sessionPresent: true,
    returnCode: 0,
    reasonCode: 0,
  });
  assert.deepEqual(decodeSuback(packets[3].payload, "5"), [0, 1]);
  assert.deepEqual(decodePublish(packets[4].payload, 1, "5"), {
    topic: "t",
    payload: "v",
    packetId: 9,
    propertiesLength: 0,
  });
});

test("29 非法 qos / 越界 packet id 抛错", () => {
  assert.throws(() => encodePublish({ topic: "a", payload: "x", qos: 3 }), RangeError);
  assert.throws(() => encodeSubscribe(1, [{ topic: "a", qos: 3 }]), RangeError);
  assert.throws(() => encodeUnsubscribe(65536, ["a"]), RangeError);
  assert.throws(() => encodeConnect({ clientId: "c", keepAliveSecs: 70000 }), RangeError);
  assert.throws(() => decodePublish(u8(0x00), 3), RangeError);
});
