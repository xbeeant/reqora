package com.xbeeant.reqora.server.identity;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** SCIM 2.0 endpoints. Authentication is a dedicated bearer token, not a local JWT. */
@RestController
@RequestMapping("/scim/v2")
public class ScimController {

    private static final String SCIM_JSON = "application/scim+json";

    private final ScimService scim;

    public ScimController(ScimService scim) {
        this.scim = scim;
    }

    @ExceptionHandler(ScimException.class)
    public ResponseEntity<Map<String, Object>> handleScim(ScimException ex) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("schemas", List.of("urn:ietf:params:scim:api:messages:2.0:Error"));
        body.put("status", String.valueOf(ex.status()));
        body.put("scimType", ex.scimType());
        body.put("detail", ex.getMessage());
        return ResponseEntity.status(ex.status())
                .contentType(MediaType.parseMediaType(SCIM_JSON))
                .body(body);
    }

    @GetMapping(value = "/ServiceProviderConfig", produces = SCIM_JSON)
    public Map<String, Object> config(@RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false)
                                      String authorization) {
        scim.guard(authorization);
        return scim.serviceProviderConfig();
    }

    @GetMapping(value = "/ResourceTypes", produces = SCIM_JSON)
    public Map<String, Object> resourceTypes(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization) {
        scim.guard(authorization);
        return scim.resourceTypes();
    }

    @GetMapping(value = "/Schemas", produces = SCIM_JSON)
    public Map<String, Object> schemas(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization) {
        scim.guard(authorization);
        return scim.schemas();
    }

    @GetMapping(value = "/Users", produces = SCIM_JSON)
    public Map<String, Object> listUsers(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
            @RequestParam(required = false) String filter,
            @RequestParam(defaultValue = "1") int startIndex,
            @RequestParam(defaultValue = "100") int count) {
        scim.guard(authorization);
        return scim.listUsers(filter, startIndex, count);
    }

    @GetMapping(value = "/Users/{id}", produces = SCIM_JSON)
    public Map<String, Object> getUser(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
            @PathVariable long id) {
        scim.guard(authorization);
        return scim.getUser(id);
    }

    @PostMapping(value = "/Users", consumes = {MediaType.APPLICATION_JSON_VALUE, SCIM_JSON},
            produces = SCIM_JSON)
    public ResponseEntity<Map<String, Object>> createUser(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
            @RequestBody JsonNode body) {
        scim.guard(authorization);
        return ResponseEntity.status(HttpStatus.CREATED).body(scim.createUser(body));
    }

    @PutMapping(value = "/Users/{id}", consumes = {MediaType.APPLICATION_JSON_VALUE, SCIM_JSON},
            produces = SCIM_JSON)
    public Map<String, Object> replaceUser(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
            @PathVariable long id, @RequestBody JsonNode body) {
        scim.guard(authorization);
        return scim.replaceUser(id, body);
    }

    @PatchMapping(value = "/Users/{id}", consumes = {MediaType.APPLICATION_JSON_VALUE, SCIM_JSON},
            produces = SCIM_JSON)
    public Map<String, Object> patchUser(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
            @PathVariable long id, @RequestBody JsonNode body) {
        scim.guard(authorization);
        return scim.patchUser(id, body);
    }

    @DeleteMapping("/Users/{id}")
    public ResponseEntity<Void> deleteUser(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
            @PathVariable long id) {
        scim.guard(authorization);
        scim.deleteUser(id);
        return ResponseEntity.noContent().build();
    }

    @GetMapping(value = "/Groups", produces = SCIM_JSON)
    public Map<String, Object> listGroups(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
            @RequestParam(defaultValue = "1") int startIndex,
            @RequestParam(defaultValue = "100") int count) {
        scim.guard(authorization);
        return scim.listGroups(startIndex, count);
    }

    @GetMapping(value = "/Groups/{id}", produces = SCIM_JSON)
    public Map<String, Object> getGroup(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
            @PathVariable long id) {
        scim.guard(authorization);
        return scim.getGroup(id);
    }

    @PostMapping(value = "/Groups", consumes = {MediaType.APPLICATION_JSON_VALUE, SCIM_JSON},
            produces = SCIM_JSON)
    public ResponseEntity<Map<String, Object>> createGroup(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
            @RequestBody JsonNode body) {
        scim.guard(authorization);
        return ResponseEntity.status(HttpStatus.CREATED).body(scim.createGroup(body));
    }

    @PatchMapping(value = "/Groups/{id}", consumes = {MediaType.APPLICATION_JSON_VALUE, SCIM_JSON},
            produces = SCIM_JSON)
    public Map<String, Object> patchGroup(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
            @PathVariable long id, @RequestBody JsonNode body) {
        scim.guard(authorization);
        return scim.patchGroup(id, body);
    }

    @DeleteMapping("/Groups/{id}")
    public ResponseEntity<Void> deleteGroup(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
            @PathVariable long id) {
        scim.guard(authorization);
        scim.deleteGroup(id);
        return ResponseEntity.noContent().build();
    }
}
