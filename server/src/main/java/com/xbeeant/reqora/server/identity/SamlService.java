package com.xbeeant.reqora.server.identity;

import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.common.ErrorCode;
import com.xbeeant.reqora.server.config.IdentityProperties;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.PublicKey;
import java.time.Instant;
import java.time.ZonedDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import java.util.zip.Deflater;
import javax.xml.XMLConstants;
import javax.xml.crypto.dsig.Reference;
import javax.xml.crypto.dsig.XMLSignature;
import javax.xml.crypto.dsig.XMLSignatureFactory;
import javax.xml.crypto.dsig.dom.DOMValidateContext;
import javax.xml.parsers.DocumentBuilderFactory;
import org.springframework.stereotype.Service;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

/**
 * SAML 2.0 SP-initiated Web Browser SSO (POST binding for the response).
 * Uses the JDK XML Digital Signature API with a pinned IdP certificate; no
 * OpenSAML dependency. Encrypted assertions, IdP-initiated SSO and SLO are
 * deliberately out of scope (see docs/IDENTITY_AND_AUDIT.md).
 */
@Service
public class SamlService {

    private static final String NS_PROTOCOL = "urn:oasis:names:tc:SAML:2.0:protocol";
    private static final String NS_ASSERTION = "urn:oasis:names:tc:SAML:2.0:assertion";
    private static final String NS_DS = XMLSignature.XMLNS;
    private static final String STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";

    public record StartResult(String redirectUrl, String requestId) {}

    public StartResult start(String providerId, IdentityProperties.SamlProvider config,
                             String acsUrl) {
        String requestId = "_" + UUID.randomUUID();
        String now = Instant.now().toString();
        String xml = "<samlp:AuthnRequest xmlns:samlp=\"" + NS_PROTOCOL + "\""
                + " xmlns:saml=\"" + NS_ASSERTION + "\""
                + " ID=\"" + requestId + "\" Version=\"2.0\" IssueInstant=\"" + now + "\""
                + " Destination=\"" + escapeXml(config.getSsoUrl()) + "\""
                + " AssertionConsumerServiceURL=\"" + escapeXml(acsUrl) + "\""
                + " ProtocolBinding=\"urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST\">"
                + "<saml:Issuer>" + escapeXml(config.getEntityId()) + "</saml:Issuer>"
                + "<samlp:NameIDPolicy Format=\"" + escapeXml(config.getNameIdFormat()) + "\""
                + " AllowCreate=\"true\"/>"
                + "</samlp:AuthnRequest>";
        String encoded = Base64.getEncoder().encodeToString(deflate(xml));
        String separator = config.getSsoUrl().contains("?") ? "&" : "?";
        String url = config.getSsoUrl() + separator + "SAMLRequest="
                + URLEncoder.encode(encoded, StandardCharsets.UTF_8)
                + "&RelayState=" + URLEncoder.encode(providerId, StandardCharsets.UTF_8);
        OidcService.requireHttps(config.getSsoUrl(), "SAML SSO URL");
        return new StartResult(url, requestId);
    }

    public IdentityClaims verify(String providerId, IdentityProperties.SamlProvider config,
                                 String samlResponse, String expectedRequestId, String acsUrl) {
        Document doc = parse(samlResponse);
        Element response = doc.getDocumentElement();
        if (!"Response".equals(response.getLocalName()) || !NS_PROTOCOL.equals(response.getNamespaceURI())) {
            throw reject("不是 SAML 2.0 Response");
        }
        String status = firstText(response, NS_PROTOCOL, "StatusCode");
        // StatusCode carries its value in the Value attribute.
        Element statusCode = firstElement(response, NS_PROTOCOL, "StatusCode");
        if (statusCode == null || !STATUS_SUCCESS.equals(statusCode.getAttribute("Value"))) {
            throw reject("IdP 返回的 SAML 状态不是 Success（" + status + "）");
        }
        String responseInResponseTo = response.getAttribute("InResponseTo");
        if (expectedRequestId != null && !expectedRequestId.equals(responseInResponseTo)) {
            throw reject("SAML InResponseTo 不匹配");
        }
        String destination = response.getAttribute("Destination");
        if (!destination.isBlank() && !destination.equals(acsUrl)) {
            throw reject("SAML Destination 与 ACS 不匹配");
        }
        checkInstant(response.getAttribute("IssueInstant"), config, "Response IssueInstant");

        Element assertion = firstElement(response, NS_ASSERTION, "Assertion");
        if (assertion == null) {
            throw reject("SAML Response 缺少 Assertion");
        }
        verifySignature(doc, response, assertion, config);
        checkConditions(response, assertion, config, expectedRequestId, acsUrl);

        String nameId = null;
        Element subject = firstElement(assertion, NS_ASSERTION, "Subject");
        if (subject != null) {
            Element nameIdElement = firstElement(subject, NS_ASSERTION, "NameID");
            if (nameIdElement != null) {
                nameId = nameIdElement.getTextContent().trim();
            }
        }
        if (nameId == null || nameId.isBlank()) {
            throw reject("SAML Assertion 缺少 NameID");
        }
        String email = attributeValue(assertion, config.getEmailAttribute());
        String username = attributeValue(assertion, config.getUsernameAttribute());
        String displayName = attributeValue(assertion, config.getNameAttribute());
        if (username == null || username.isBlank()) {
            username = email != null && email.contains("@") ? email.substring(0, email.indexOf('@')) : nameId;
        }
        if (displayName == null || displayName.isBlank()) {
            displayName = username;
        }
        return new IdentityClaims(providerId, "saml", nameId, username, email, displayName, List.of());
    }

    /** Unverified lookup key only: the real check happens after signature validation. */
    public static String inResponseTo(String samlResponse) {
        try {
            return parse(samlResponse).getDocumentElement().getAttribute("InResponseTo");
        } catch (BizException ex) {
            throw ex;
        } catch (Exception ex) {
            return null;
        }
    }

    // ------------------------------------------------------------- signature / wrapping ----

    private void verifySignature(Document doc, Element response, Element assertion,
                                 IdentityProperties.SamlProvider config) {
        registerIds(doc);
        NodeList signatures = doc.getElementsByTagNameNS(NS_DS, "Signature");
        if (signatures.getLength() == 0) {
            throw reject("SAML Response 未签名");
        }
        PublicKey pinned = IdentityCrypto.certificate(config.getCertificate()).getPublicKey();
        for (int i = 0; i < signatures.getLength(); i++) {
            Element signatureNode = (Element) signatures.item(i);
            Node parent = signatureNode.getParentNode();
            if (!(parent instanceof Element signed) || (signed != response && signed != assertion)) {
                continue;
            }
            String signedId = signed.getAttribute("ID");
            if (signedId.isBlank()) {
                continue;
            }
            try {
                DOMValidateContext context = new DOMValidateContext(pinned, signatureNode);
                context.setProperty("org.jcp.xml.dsig.secureValidation", Boolean.TRUE);
                XMLSignature signature = XMLSignatureFactory.getInstance("DOM")
                        .unmarshalXMLSignature(context);
                @SuppressWarnings("unchecked")
                List<Reference> references = (List<Reference>) signature.getSignedInfo().getReferences();
                if (references.size() != 1
                        || !("#" + signedId).equals(references.get(0).getURI())) {
                    continue; // reject signatures that cover a different element
                }
                if (signature.validate(context)) {
                    return;
                }
            } catch (Exception ignored) {
                // Try the next signature; a mixed signed Response+Assertion is legal.
            }
        }
        throw reject("SAML 签名校验失败（或签名未覆盖 Response/Assertion）");
    }

    /** Makes ID attributes resolvable for same-document references like URI="#_abc". */
    private void registerIds(Document doc) {
        NodeList all = doc.getElementsByTagName("*");
        for (int i = 0; i < all.getLength(); i++) {
            Element element = (Element) all.item(i);
            if (element.hasAttribute("ID")) {
                element.setIdAttribute("ID", true);
            }
        }
    }

    // ---------------------------------------------------------------------- conditions ----

    private void checkConditions(Element response, Element assertion,
                                 IdentityProperties.SamlProvider config,
                                 String requestId, String acsUrl) {
        Element issuer = firstElement(assertion, NS_ASSERTION, "Issuer");
        if (issuer != null && config.getIdpEntityId() != null
                && !config.getIdpEntityId().isBlank()
                && !config.getIdpEntityId().equals(issuer.getTextContent().trim())) {
            throw reject("SAML Issuer 与配置不一致");
        }
        Element conditions = firstElement(assertion, NS_ASSERTION, "Conditions");
        Instant now = Instant.now();
        long skew = config.getClockSkew().getSeconds();
        if (conditions != null) {
            Instant notBefore = parseInstant(conditions.getAttribute("NotBefore"));
            Instant notOnOrAfter = parseInstant(conditions.getAttribute("NotOnOrAfter"));
            if (notBefore != null && now.plusSeconds(skew).isBefore(notBefore)) {
                throw reject("SAML Assertion 尚未生效");
            }
            if (notOnOrAfter != null && !now.minusSeconds(skew).isBefore(notOnOrAfter)) {
                throw reject("SAML Assertion 已过期");
            }
            NodeList restrictions = conditions.getElementsByTagNameNS(NS_ASSERTION, "AudienceRestriction");
            if (restrictions.getLength() > 0) {
                boolean audienceOk = false;
                for (Element audience : elements(conditions, NS_ASSERTION, "Audience")) {
                    if (config.getEntityId().equals(audience.getTextContent().trim())) {
                        audienceOk = true;
                        break;
                    }
                }
                if (!audienceOk) {
                    throw reject("SAML AudienceRestriction 不含本 SP 的 entityID");
                }
            }
        }
        Element subjectConfirmationData = firstElement(assertion, NS_ASSERTION, "SubjectConfirmationData");
        if (subjectConfirmationData != null) {
            Instant expires = parseInstant(subjectConfirmationData.getAttribute("NotOnOrAfter"));
            if (expires != null && !now.minusSeconds(skew).isBefore(expires)) {
                throw reject("SAML SubjectConfirmation 已过期");
            }
            String recipient = subjectConfirmationData.getAttribute("Recipient");
            if (!recipient.isBlank() && !recipient.equals(acsUrl)) {
                throw reject("SAML Recipient 与 ACS 不匹配");
            }
            String inResponseTo = subjectConfirmationData.getAttribute("InResponseTo");
            if (requestId != null && !inResponseTo.isBlank() && !requestId.equals(inResponseTo)) {
                throw reject("SAML SubjectConfirmation InResponseTo 不匹配");
            }
        }
    }

    // ---------------------------------------------------------------------------- utils ----

    private static Document parse(String base64) {
        try {
            byte[] bytes = Base64.getMimeDecoder().decode(base64);
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setNamespaceAware(true);
            factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
            factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
            factory.setFeature("http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
            factory.setXIncludeAware(false);
            factory.setExpandEntityReferences(false);
            return factory.newDocumentBuilder().parse(new ByteArrayInputStream(bytes));
        } catch (Exception ex) {
            throw new BizException(ErrorCode.BAD_REQUEST, "SAMLResponse 无法解析（已禁用外部实体）");
        }
    }

    private String attributeValue(Element assertion, String name) {
        if (name == null || name.isBlank()) {
            return null;
        }
        for (Element attribute : elements(assertion, NS_ASSERTION, "Attribute")) {
            if (name.equals(attribute.getAttribute("Name"))) {
                Element value = firstElement(attribute, NS_ASSERTION, "AttributeValue");
                if (value != null) {
                    return value.getTextContent().trim();
                }
            }
        }
        return null;
    }

    private void checkInstant(String value, IdentityProperties.SamlProvider config, String label) {
        Instant instant = parseInstant(value);
        if (instant == null) {
            return;
        }
        if (Instant.now().plusSeconds(config.getClockSkew().getSeconds()).isBefore(instant)
                || instant.isBefore(Instant.now().minus(config.getMaxAssertionAge()))) {
            throw reject("SAML " + label + " 超出允许的时间窗");
        }
    }

    private static Instant parseInstant(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return ZonedDateTime.parse(value).toInstant();
        } catch (DateTimeParseException ex) {
            try {
                return Instant.parse(value);
            } catch (DateTimeParseException ignored) {
                return null;
            }
        }
    }

    private static Element firstElement(Element root, String ns, String localName) {
        NodeList nodes = root.getElementsByTagNameNS(ns, localName);
        return nodes.getLength() == 0 ? null : (Element) nodes.item(0);
    }

    private static String firstText(Element root, String ns, String localName) {
        Element element = firstElement(root, ns, localName);
        return element == null ? "" : element.getTextContent().trim();
    }

    private static List<Element> elements(Element root, String ns, String localName) {
        NodeList nodes = root.getElementsByTagNameNS(ns, localName);
        List<Element> out = new ArrayList<>();
        for (int i = 0; i < nodes.getLength(); i++) {
            out.add((Element) nodes.item(i));
        }
        return out;
    }

    private static byte[] deflate(String xml) {
        try (ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            Deflater deflater = new Deflater(Deflater.DEFLATED, true);
            deflater.setInput(xml.getBytes(StandardCharsets.UTF_8));
            deflater.finish();
            byte[] buffer = new byte[1024];
            while (!deflater.finished()) {
                int n = deflater.deflate(buffer);
                out.write(buffer, 0, n);
            }
            deflater.end();
            return out.toByteArray();
        } catch (Exception ex) {
            throw new IllegalStateException("SAML AuthnRequest 压缩失败", ex);
        }
    }

    private static String escapeXml(String value) {
        if (value == null) {
            return "";
        }
        return value.replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&apos;");
    }

    private static BizException reject(String message) {
        return new BizException(ErrorCode.UNAUTHENTICATED, message);
    }
}
