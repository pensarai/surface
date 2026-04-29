<?php

use Illuminate\Support\Facades\Route;
use App\Http\Controllers\AboutController;

Route::get('/', fn() => view('home'));
Route::get('/about', [AboutController::class, 'show']);
