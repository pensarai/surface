package com.example.demo;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class UserApiController {

    @GetMapping("/api/users")
    public String listUsers() {
        return "[]";
    }
}
