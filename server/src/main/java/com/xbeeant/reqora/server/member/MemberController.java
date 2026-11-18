package com.xbeeant.reqora.server.member;

import com.xbeeant.reqora.server.common.ApiResponse;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/projects/{projectId}/members")
public class MemberController {

    private final MemberService memberService;

    public MemberController(MemberService memberService) {
        this.memberService = memberService;
    }

    @GetMapping
    public ApiResponse<java.util.List<MemberDtos.MemberView>> list(@PathVariable long projectId) {
        return ApiResponse.ok(memberService.list(projectId));
    }

    @PostMapping
    public ApiResponse<MemberDtos.MemberView> add(
            @PathVariable long projectId, @Valid @RequestBody MemberDtos.AddMemberRequest request) {
        return ApiResponse.ok(memberService.add(projectId, request));
    }

    @PutMapping("/{userId}/role")
    public ApiResponse<MemberDtos.MemberView> changeRole(
            @PathVariable long projectId,
            @PathVariable long userId,
            @Valid @RequestBody MemberDtos.UpdateMemberRequest request) {
        return ApiResponse.ok(memberService.changeRole(projectId, userId, request));
    }

    @DeleteMapping("/{userId}")
    public ApiResponse<Void> remove(@PathVariable long projectId, @PathVariable long userId) {
        memberService.remove(projectId, userId);
        return ApiResponse.ok(null);
    }

    @PostMapping("/transfer-owner")
    public ApiResponse<Void> transferOwner(
            @PathVariable long projectId,
            @Valid @RequestBody MemberDtos.TransferOwnerRequest request) {
        memberService.transferOwner(projectId, request);
        return ApiResponse.ok(null);
    }
}
