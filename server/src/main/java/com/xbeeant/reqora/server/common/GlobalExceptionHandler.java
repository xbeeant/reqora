package com.xbeeant.reqora.server.common;

import jakarta.validation.ConstraintViolationException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.validation.FieldError;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

/** Single place that turns every failure into the standard envelope. Never leaks stack traces. */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(BizException.class)
    public ResponseEntity<ApiResponse<Void>> handleBiz(BizException ex) {
        return build(ex.error(), ex.getMessage());
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiResponse<Void>> handleValidation(MethodArgumentNotValidException ex) {
        String detail = ex.getBindingResult().getFieldErrors().stream()
                .findFirst()
                .map(this::describe)
                .orElse(Messages.get(ErrorCode.BAD_REQUEST));
        return build(ErrorCode.BAD_REQUEST, detail);
    }

    @ExceptionHandler(ConstraintViolationException.class)
    public ResponseEntity<ApiResponse<Void>> handleConstraint(ConstraintViolationException ex) {
        return build(ErrorCode.BAD_REQUEST, Messages.get("common.constraint_violation", ex.getMessage()));
    }

    @ExceptionHandler({HttpMessageNotReadableException.class, MissingServletRequestParameterException.class,
            MethodArgumentTypeMismatchException.class})
    public ResponseEntity<ApiResponse<Void>> handleMalformed(Exception ex) {
        // Jackson wraps the real failure (bad JSON token, type mismatch, ...) in
        // HttpMessageNotReadableException; without this log the client-side
        // "请求格式不合法" is undiagnosable. The message names the exact JSON path.
        Throwable cause = ex instanceof HttpMessageNotReadableException
                ? ((HttpMessageNotReadableException) ex).getMostSpecificCause()
                : ex;
        log.warn("malformed request rejected: {}", cause.getMessage(), ex);
        String detail = cause.getMessage();
        if (detail != null && detail.length() > 300) {
            detail = detail.substring(0, 300) + "...";
        }
        return ResponseEntity.status(ErrorCode.BAD_REQUEST.status())
                .body(ApiResponse.fail(ErrorCode.BAD_REQUEST,
                        detail == null ? null : Messages.get("common.malformed", detail)));
    }

    @ExceptionHandler(AccessDeniedException.class)
    public ResponseEntity<ApiResponse<Void>> handleAccessDenied(AccessDeniedException ex) {
        return build(ErrorCode.FORBIDDEN, null);
    }

    @ExceptionHandler(AuthenticationException.class)
    public ResponseEntity<ApiResponse<Void>> handleAuthentication(AuthenticationException ex) {
        return build(ErrorCode.UNAUTHENTICATED, null);
    }

    @ExceptionHandler(DataIntegrityViolationException.class)
    public ResponseEntity<ApiResponse<Void>> handleIntegrity(DataIntegrityViolationException ex) {
        log.warn("data integrity violation", ex);
        return build(ErrorCode.CONFLICT, Messages.get("common.data_conflict"));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResponse<Void>> handleUnexpected(Exception ex) {
        log.error("unhandled exception", ex);
        return build(ErrorCode.INTERNAL, null);
    }

    private String describe(FieldError error) {
        return Messages.get("common.validation_field", error.getField(), error.getDefaultMessage());
    }

    private ResponseEntity<ApiResponse<Void>> build(ErrorCode error, String message) {
        String detail = message == null || message.isBlank() ? Messages.get(error) : message;
        return ResponseEntity.status(error.status()).body(ApiResponse.fail(error, detail));
    }
}
