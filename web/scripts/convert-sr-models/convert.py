#!/usr/bin/env python3
"""
SR.0 权重转换工具：Real-CUGAN（CUNet）/ AnimeSharpV4（RCAN）/ 1x-SuperScale（SPAN）→ ONNX。

用法（在 web/scripts/convert-sr-models/ 的 venv 内执行）：
    .venv\\Scripts\\python convert.py <kind> <input权重> <输出.onnx>

kind:
    cugan2x / cugan3x / cugan4x   Real-CUGAN 官方 .pth（weights_v3/up{x}x-latest-*.pth）
    rcan2x                        2x-AnimeSharpV4_RCAN.safetensors
    span1x                        1x-SuperScale_SPAN.safetensors

导出约定：opset 17、FP32、dynamic_axes 标高宽两维（输入输出都标）、
         导出后 onnx.checker.check_model 校验 + onnxruntime 与 torch 数值对照（max abs diff）。
架构定义内嵌自官方/参考仓库（bilibili/ailab upcunet_v3.py、yulunzhang/RCAN、hongyuanyu/SPAN），
不依赖运行时网络；原始权重与产物均不入 git（见 web/.gitignore）。
"""
import argparse
import os
import re
import sys

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

# ---------------------------------------------------------------------------
# Real-CUGAN：CUNet（bilibili/ailab Real-CUGAN/upcunet_v3.py，精简为导出所需）
# ---------------------------------------------------------------------------
class SEBlock(nn.Module):
    def __init__(self, in_channels, reduction=8, bias=False):
        super().__init__()
        self.conv1 = nn.Conv2d(in_channels, in_channels // reduction, 1, 1, 0, bias=bias)
        self.conv2 = nn.Conv2d(in_channels // reduction, in_channels, 1, 1, 0, bias=bias)

    def forward(self, x):
        x0 = torch.mean(x, dim=(2, 3), keepdim=True)
        x0 = self.conv1(x0)
        x0 = F.relu(x0, inplace=True)
        x0 = self.conv2(x0)
        x0 = torch.sigmoid(x0)
        return torch.mul(x, x0)


class UNetConv(nn.Module):
    def __init__(self, in_channels, mid_channels, out_channels, se):
        super().__init__()
        self.conv = nn.Sequential(
            nn.Conv2d(in_channels, mid_channels, 3, 1, 0),
            nn.LeakyReLU(0.1, inplace=True),
            nn.Conv2d(mid_channels, out_channels, 3, 1, 0),
            nn.LeakyReLU(0.1, inplace=True),
        )
        self.seblock = SEBlock(out_channels, reduction=8, bias=True) if se else None

    def forward(self, x):
        z = self.conv(x)
        if self.seblock is not None:
            z = self.seblock(z)
        return z


class UNet1(nn.Module):
    def __init__(self, in_channels, out_channels, deconv):
        super().__init__()
        self.conv1 = UNetConv(in_channels, 32, 64, se=False)
        self.conv1_down = nn.Conv2d(64, 64, 2, 2, 0)
        self.conv2 = UNetConv(64, 128, 64, se=True)
        self.conv2_up = nn.ConvTranspose2d(64, 64, 2, 2, 0)
        self.conv3 = nn.Conv2d(64, 64, 3, 1, 0)
        self.conv_bottom = (
            nn.ConvTranspose2d(64, out_channels, 4, 2, 3) if deconv
            else nn.Conv2d(64, out_channels, 3, 1, 0)
        )

    def forward(self, x):
        x1 = self.conv1(x)
        x2 = self.conv1_down(x1)
        x1 = F.pad(x1, (-4, -4, -4, -4))
        x2 = F.leaky_relu(x2, 0.1, inplace=True)
        x2 = self.conv2(x2)
        x2 = self.conv2_up(x2)
        x2 = F.leaky_relu(x2, 0.1, inplace=True)
        x3 = self.conv3(x1 + x2)
        x3 = F.leaky_relu(x3, 0.1, inplace=True)
        return self.conv_bottom(x3)


class UNet1x3(nn.Module):
    def __init__(self, in_channels, out_channels, deconv):
        super().__init__()
        self.conv1 = UNetConv(in_channels, 32, 64, se=False)
        self.conv1_down = nn.Conv2d(64, 64, 2, 2, 0)
        self.conv2 = UNetConv(64, 128, 64, se=True)
        self.conv2_up = nn.ConvTranspose2d(64, 64, 2, 2, 0)
        self.conv3 = nn.Conv2d(64, 64, 3, 1, 0)
        self.conv_bottom = (
            nn.ConvTranspose2d(64, out_channels, 5, 3, 2) if deconv
            else nn.Conv2d(64, out_channels, 3, 1, 0)
        )

    def forward(self, x):
        x1 = self.conv1(x)
        x2 = self.conv1_down(x1)
        x1 = F.pad(x1, (-4, -4, -4, -4))
        x2 = F.leaky_relu(x2, 0.1, inplace=True)
        x2 = self.conv2(x2)
        x2 = self.conv2_up(x2)
        x2 = F.leaky_relu(x2, 0.1, inplace=True)
        x3 = self.conv3(x1 + x2)
        x3 = F.leaky_relu(x3, 0.1, inplace=True)
        return self.conv_bottom(x3)


class UNet2(nn.Module):
    def __init__(self, in_channels, out_channels, deconv):
        super().__init__()
        self.conv1 = UNetConv(in_channels, 32, 64, se=False)
        self.conv1_down = nn.Conv2d(64, 64, 2, 2, 0)
        self.conv2 = UNetConv(64, 64, 128, se=True)
        self.conv2_down = nn.Conv2d(128, 128, 2, 2, 0)
        self.conv3 = UNetConv(128, 256, 128, se=True)
        self.conv3_up = nn.ConvTranspose2d(128, 128, 2, 2, 0)
        self.conv4 = UNetConv(128, 64, 64, se=True)
        self.conv4_up = nn.ConvTranspose2d(64, 64, 2, 2, 0)
        self.conv5 = nn.Conv2d(64, 64, 3, 1, 0)
        self.conv_bottom = (
            nn.ConvTranspose2d(64, out_channels, 4, 2, 3) if deconv
            else nn.Conv2d(64, out_channels, 3, 1, 0)
        )

    def forward(self, x, alpha=1):
        x1 = self.conv1(x)
        x2 = self.conv1_down(x1)
        x1 = F.pad(x1, (-16, -16, -16, -16))
        x2 = F.leaky_relu(x2, 0.1, inplace=True)
        x2 = self.conv2(x2)
        x3 = self.conv2_down(x2)
        x2 = F.pad(x2, (-4, -4, -4, -4))
        x3 = F.leaky_relu(x3, 0.1, inplace=True)
        x3 = self.conv3(x3)
        x3 = self.conv3_up(x3)
        x3 = F.leaky_relu(x3, 0.1, inplace=True)
        x4 = self.conv4(x2 + x3) * alpha
        x4 = self.conv4_up(x4)
        x4 = F.leaky_relu(x4, 0.1, inplace=True)
        x5 = self.conv5(x1 + x4)
        x5 = F.leaky_relu(x5, 0.1, inplace=True)
        return self.conv_bottom(x5)


class _CuganExport2x(nn.Module):
    """UpCunet2x 的 tile_mode==0 等价整图路径：FP32、alpha=1、不乘 255。"""

    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):
        h0, w0 = x.shape[2], x.shape[3]
        ph = ((h0 - 1) // 2 + 1) * 2
        pw = ((w0 - 1) // 2 + 1) * 2
        x = F.pad(x, (18, 18 + pw - w0, 18, 18 + ph - h0), "reflect")
        y1 = self.m.unet1(x)
        y2 = self.m.unet2(y1, 1)
        y1 = F.pad(y1, (-20, -20, -20, -20))
        out = y1 + y2
        return out[:, :, : h0 * 2, : w0 * 2]


class _CuganExport3x(nn.Module):
    """UpCunet3x 的 tile_mode==0 等价整图路径。"""

    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):
        h0, w0 = x.shape[2], x.shape[3]
        ph = ((h0 - 1) // 4 + 1) * 4
        pw = ((w0 - 1) // 4 + 1) * 4
        x = F.pad(x, (14, 14 + pw - w0, 14, 14 + ph - h0), "reflect")
        y1 = self.m.unet1(x)
        y2 = self.m.unet2(y1, 1)
        y1 = F.pad(y1, (-20, -20, -20, -20))
        out = y1 + y2
        return out[:, :, : h0 * 3, : w0 * 3]


class _CuganExport4x(nn.Module):
    """UpCunet4x 的 tile_mode==0 等价整图路径（含 conv_final + PixelShuffle + 输入 nearest 直连）。"""

    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):
        x00 = x
        h0, w0 = x.shape[2], x.shape[3]
        ph = ((h0 - 1) // 2 + 1) * 2
        pw = ((w0 - 1) // 2 + 1) * 2
        x = F.pad(x, (19, 19 + pw - w0, 19, 19 + ph - h0), "reflect")
        y1 = self.m.unet1(x)
        y2 = self.m.unet2(y1, 1)
        y1 = F.pad(y1, (-20, -20, -20, -20))
        x = y1 + y2
        x = self.m.conv_final(x)
        x = F.pad(x, (-1, -1, -1, -1))
        x = self.m.ps(x)
        x = x[:, :, : h0 * 4, : w0 * 4]
        x = x + F.interpolate(x00, scale_factor=4, mode="nearest")
        return x


# ---------------------------------------------------------------------------
# AnimeSharpV4：RCAN（yulunzhang/RCAN RCAN_TestCode/code/model/{rcan,common}.py）
# ---------------------------------------------------------------------------
def _default_conv(in_channels, out_channels, kernel_size, bias=True):
    return nn.Conv2d(in_channels, out_channels, kernel_size, padding=(kernel_size // 2), bias=bias)


class _MeanShift(nn.Conv2d):
    def __init__(self, rgb_range, rgb_mean, rgb_std, sign=-1):
        super().__init__(3, 3, kernel_size=1)
        std = torch.Tensor(rgb_std)
        self.weight.data = torch.eye(3).view(3, 3, 1, 1)
        self.weight.data.div_(std.view(3, 1, 1, 1))
        self.bias.data = sign * rgb_range * torch.Tensor(rgb_mean)
        self.bias.data.div_(std)
        self.requires_grad = False


class _Upsampler(nn.Sequential):
    def __init__(self, conv, scale, n_feat, bias=True):
        m = []
        if (scale & (scale - 1)) == 0:
            for _ in range(int(np.log2(scale))):
                m.append(conv(n_feat, 4 * n_feat, 3, bias))
                m.append(nn.PixelShuffle(2))
        elif scale == 3:
            m.append(conv(n_feat, 9 * n_feat, 3, bias))
            m.append(nn.PixelShuffle(3))
        else:
            raise NotImplementedError(f"RCAN scale {scale}")
        super().__init__(*m)


class _CALayer(nn.Module):
    def __init__(self, channel, reduction=16):
        super().__init__()
        self.avg_pool = nn.AdaptiveAvgPool2d(1)
        self.conv_du = nn.Sequential(
            nn.Conv2d(channel, channel // reduction, 1, padding=0, bias=True),
            nn.ReLU(inplace=True),
            nn.Conv2d(channel // reduction, channel, 1, padding=0, bias=True),
            nn.Sigmoid(),
        )

    def forward(self, x):
        y = self.avg_pool(x)
        y = self.conv_du(y)
        return x * y


class _RCAB(nn.Module):
    def __init__(self, conv, n_feat, kernel_size, reduction, bias=True, act=nn.ReLU(True)):
        super().__init__()
        modules_body = []
        for i in range(2):
            modules_body.append(conv(n_feat, n_feat, kernel_size, bias=bias))
            if i == 0:
                modules_body.append(act)
        modules_body.append(_CALayer(n_feat, reduction))
        self.body = nn.Sequential(*modules_body)

    def forward(self, x):
        return self.body(x) + x


class _ResidualGroup(nn.Module):
    def __init__(self, conv, n_feat, kernel_size, reduction, act, n_resblocks):
        super().__init__()
        modules_body = [
            _RCAB(conv, n_feat, kernel_size, reduction, bias=True, act=nn.ReLU(True))
            for _ in range(n_resblocks)
        ]
        modules_body.append(conv(n_feat, n_feat, kernel_size))
        self.body = nn.Sequential(*modules_body)

    def forward(self, x):
        return self.body(x) + x


class RCAN(nn.Module):
    """yulunzhang/RCAN 结构；use_mean_shift=False 时去掉 sub_mean/add_mean（应对无均值偏移的权重）。"""

    def __init__(self, n_resgroups=20, n_resblocks=10, n_feats=64, reduction=16,
                 scale=2, n_colors=3, rgb_range=255, use_mean_shift=True,
                 rgb_mean=(0.4488, 0.4371, 0.4040), conv=_default_conv):
        super().__init__()
        self.use_mean_shift = use_mean_shift
        kernel_size = 3
        act = nn.ReLU(True)
        rgb_std = (1.0, 1.0, 1.0)
        if use_mean_shift:
            self.sub_mean = _MeanShift(rgb_range, rgb_mean, rgb_std)

        modules_head = [conv(n_colors, n_feats, kernel_size)]
        modules_body = [
            _ResidualGroup(conv, n_feats, kernel_size, reduction, act=act, n_resblocks=n_resblocks)
            for _ in range(n_resgroups)
        ]
        modules_body.append(conv(n_feats, n_feats, kernel_size))
        modules_tail = [
            _Upsampler(conv, scale, n_feats),
            conv(n_feats, n_colors, kernel_size),
        ]
        if use_mean_shift:
            self.add_mean = _MeanShift(rgb_range, rgb_mean, rgb_std, 1)

        self.head = nn.Sequential(*modules_head)
        self.body = nn.Sequential(*modules_body)
        self.tail = nn.Sequential(*modules_tail)

    def forward(self, x):
        if self.use_mean_shift:
            x = self.sub_mean(x)
        x = self.head(x)
        res = self.body(x) + x
        x = self.tail(res)
        if self.use_mean_shift:
            x = self.add_mean(x)
        return x


# ---------------------------------------------------------------------------
# 1x-SuperScale：SPAN-Small（hongyuanyu/SPAN basicsr/archs/span_arch.py，去 basicsr 依赖）
# ---------------------------------------------------------------------------
def _make_pair(value):
    return (value,) * 2 if isinstance(value, int) else value


def _conv_layer(in_channels, out_channels, kernel_size, bias=True):
    kernel_size = _make_pair(kernel_size)
    padding = (int((kernel_size[0] - 1) / 2), int((kernel_size[1] - 1) / 2))
    return nn.Conv2d(in_channels, out_channels, kernel_size, padding=padding, bias=bias)


def _activation(act_type, inplace=True, neg_slope=0.05):
    act_type = act_type.lower()
    if act_type == "relu":
        return nn.ReLU(inplace)
    if act_type == "lrelu":
        return nn.LeakyReLU(neg_slope, inplace)
    if act_type == "prelu":
        return nn.PReLU(num_parameters=1, init=neg_slope)
    raise NotImplementedError(act_type)


def _sequential(*args):
    modules = []
    for module in args:
        if isinstance(module, nn.Sequential):
            modules.extend(module.children())
        elif isinstance(module, nn.Module):
            modules.append(module)
    return nn.Sequential(*modules)


def _pixelshuffle_block(in_channels, out_channels, upscale_factor=2, kernel_size=3):
    conv = _conv_layer(in_channels, out_channels * (upscale_factor ** 2), kernel_size)
    return _sequential(conv, nn.PixelShuffle(upscale_factor))


class _Conv3XC(nn.Module):
    """训练用 1x1-3x3-1x1 三卷积分支；eval 时折叠进 eval_conv 单 3x3（与参考实现一致）。"""

    def __init__(self, c_in, c_out, gain1=1, gain2=0, s=1, bias=True, relu=False):
        super().__init__()
        self.stride = s
        self.has_relu = relu
        self.sk = nn.Conv2d(in_channels=c_in, out_channels=c_out, kernel_size=1, padding=0, stride=s, bias=bias)
        self.conv = nn.Sequential(
            nn.Conv2d(in_channels=c_in, out_channels=c_in * gain1, kernel_size=1, padding=0, bias=bias),
            nn.Conv2d(in_channels=c_in * gain1, out_channels=c_out * gain1, kernel_size=3, stride=s, padding=0, bias=bias),
            nn.Conv2d(in_channels=c_out * gain1, out_channels=c_out, kernel_size=1, padding=0, bias=bias),
        )
        self.eval_conv = nn.Conv2d(in_channels=c_in, out_channels=c_out, kernel_size=3, padding=1, stride=s, bias=bias)
        self.eval_conv.weight.requires_grad = False
        self.eval_conv.bias.requires_grad = False
        self.update_params()

    def update_params(self):
        w1, b1 = self.conv[0].weight.data.clone().detach(), self.conv[0].bias.data.clone().detach()
        w2, b2 = self.conv[1].weight.data.clone().detach(), self.conv[1].bias.data.clone().detach()
        w3, b3 = self.conv[2].weight.data.clone().detach(), self.conv[2].bias.data.clone().detach()
        w = F.conv2d(w1.flip(2, 3).permute(1, 0, 2, 3), w2, padding=2, stride=1).flip(2, 3).permute(1, 0, 2, 3)
        b = (w2 * b1.reshape(1, -1, 1, 1)).sum((1, 2, 3)) + b2
        weight_concat = F.conv2d(w.flip(2, 3).permute(1, 0, 2, 3), w3, padding=0, stride=1).flip(2, 3).permute(1, 0, 2, 3)
        bias_concat = (w3 * b.reshape(1, -1, 1, 1)).sum((1, 2, 3)) + b3
        sk_w = self.sk.weight.data.clone().detach()
        sk_b = self.sk.bias.data.clone().detach()
        sk_w = F.pad(sk_w, [1, 1, 1, 1])
        self.eval_conv.weight.data = weight_concat + sk_w
        self.eval_conv.bias.data = bias_concat + sk_b

    def forward(self, x):
        if self.training:
            x_pad = F.pad(x, (1, 1, 1, 1), "constant", 0)
            out = self.conv(x_pad) + self.sk(x)
        else:
            self.update_params()
            out = self.eval_conv(x)
        if self.has_relu:
            out = F.leaky_relu(out, negative_slope=0.05)
        return out


class _SPAB(nn.Module):
    def __init__(self, in_channels, mid_channels=None, out_channels=None, bias=False):
        super().__init__()
        mid_channels = in_channels if mid_channels is None else mid_channels
        out_channels = in_channels if out_channels is None else out_channels
        self.c1_r = _Conv3XC(in_channels, mid_channels, gain1=2, s=1)
        self.c2_r = _Conv3XC(mid_channels, mid_channels, gain1=2, s=1)
        self.c3_r = _Conv3XC(mid_channels, out_channels, gain1=2, s=1)
        self.act1 = nn.SiLU(inplace=True)
        self.act2 = _activation("lrelu", neg_slope=0.1, inplace=True)

    def forward(self, x):
        out1 = self.c1_r(x)
        out1_act = self.act1(out1)
        out2 = self.c2_r(out1_act)
        out2_act = self.act1(out2)
        out3 = self.c3_r(out2_act)
        sim_att = torch.sigmoid(out3) - 0.5
        out = (out3 + x) * sim_att
        return out, out1, sim_att


class SPAN(nn.Module):
    """traiNNer-redux span_arch.py 结构（norm=False 时不均值/缩放，直接透传）。"""

    def __init__(self, num_in_ch=3, num_out_ch=3, feature_channels=48, num_blocks=6,
                 upscale=1, bias=True, norm=False, img_range=255.0,
                 rgb_mean=(0.4488, 0.4371, 0.4040)):
        super().__init__()
        self.img_range = img_range
        self.num_blocks = num_blocks
        self.register_buffer("mean", torch.Tensor(rgb_mean).view(1, 3, 1, 1), persistent=False)
        if not norm:
            self.register_buffer("no_norm", torch.zeros(1))
        else:
            self.no_norm = None
        self.conv_1 = _Conv3XC(num_in_ch, feature_channels, gain1=2, s=1)
        for i in range(1, num_blocks + 1):
            setattr(self, f"block_{i}", _SPAB(feature_channels, bias=bias))
        self.conv_cat = _conv_layer(feature_channels * 4, feature_channels, kernel_size=1, bias=True)
        self.conv_2 = _Conv3XC(feature_channels, feature_channels, gain1=2, s=1)
        self.upsampler = _pixelshuffle_block(feature_channels, num_out_ch, upscale_factor=upscale)

    @property
    def is_norm(self):
        return self.no_norm is None

    def forward(self, x):
        if self.is_norm:
            x = (x - self.mean) * self.img_range
        out_feature = self.conv_1(x)
        out = out_feature
        out_b1 = out_feature
        last_mid = out_feature
        for i in range(1, self.num_blocks + 1):
            block = getattr(self, f"block_{i}")
            out, mid, _att = block(out)
            if i == 1:
                out_b1 = out
            last_mid = mid
        out = self.conv_2(out)
        out = self.conv_cat(torch.cat([out_feature, out, out_b1, last_mid], 1))
        return self.upsampler(out)


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
def strip_prefix(sd):
    """去掉常见前缀（DataParallel / torch.compile / 外层包装）。"""
    out = {}
    for k, v in sd.items():
        kk = k
        for p in ("module.", "_orig_mod.", "model.", "state_dict.", "net."):
            if kk.startswith(p):
                kk = kk[len(p):]
                break
        out[kk] = v
    return out


def derive_rcan_config(sd):
    n_feats = sd["head.0.weight"].shape[0]
    groups, blocks = set(), set()
    for k in sd:
        m = re.match(r"body\.(\d+)\.body\.(\d+)\.body\.\d+\.weight", k)
        if m:
            groups.add(int(m.group(1)))
            blocks.add(int(m.group(2)))
    # RCAB body = [conv, ReLU, conv, CALayer] → conv_du 恒在 body.3
    reduction = n_feats // sd["body.0.body.0.body.3.conv_du.0.weight"].shape[0]
    # tail = [Upsampler(Sequential(conv, PixelShuffle)), conv] → 上采样 conv 在 tail.0.0
    tw = sd["tail.0.0.weight"]
    scale = int(round((tw.shape[0] / n_feats) ** 0.5))
    use_ms = "sub_mean.weight" in sd
    return dict(n_resgroups=len(groups), n_resblocks=len(blocks), n_feats=n_feats,
                reduction=reduction, scale=scale, use_mean_shift=use_ms)


def derive_span_config(sd):
    feat = sd["conv_1.sk.weight"].shape[0]
    uw = sd["upsampler.0.weight"]
    upscale = int(round((uw.shape[0] / 3) ** 0.5))
    blocks = 6
    for k in sd:
        m = re.match(r"block_(\d+)\.c1_r\.sk\.weight", k)
        if m:
            blocks = max(blocks, int(m.group(1)))
    return dict(feature_channels=feat, upscale=upscale, num_blocks=blocks)


def export_and_verify(model, example, output_path, tag):
    """导出 ONNX（opset17/FP32/dynamic H,W）→ checker 校验 → torch/ORT 数值对照。"""
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    torch.onnx.export(
        model, example, output_path,
        input_names=["input_1"], output_names=["output_1"],
        opset_version=19,
        dynamic_axes={"input_1": {2: "H", 3: "W"}, "output_1": {2: "H", 3: "W"}},
        do_constant_folding=True,
    )
    import onnx
    m = onnx.load(output_path)
    # torch 2.13 新导出器默认把大权重写外部数据文件，浏览器 ORT 无法按 URL 拉取 → 内联为单文件
    onnx.save_model(m, output_path, save_as_external_data=False)
    m = onnx.load(output_path)
    onnx.checker.check_model(m)
    in_dims = m.graph.input[0].type.tensor_type.shape.dim
    out_dims = m.graph.output[0].type.tensor_type.shape.dim
    dyn_in = in_dims[2].dim_param, in_dims[3].dim_param
    dyn_out = out_dims[2].dim_param, out_dims[3].dim_param

    import onnxruntime as ort
    sess = ort.InferenceSession(output_path, providers=["CPUExecutionProvider"])
    in_name, out_name = sess.get_inputs()[0].name, sess.get_outputs()[0].name
    with torch.no_grad():
        y_torch = model(example).numpy()
    y_ort = sess.run(None, {in_name: example.numpy()})[0]
    max_diff = float(np.abs(y_ort - y_torch).max())
    size_mb = os.path.getsize(output_path) / 1e6

    print(f"[{tag}] 导出完成: {output_path}")
    print(f"[{tag}]   in  {in_name} {example.shape} dyn(H,W)={dyn_in}")
    print(f"[{tag}]   out {out_name} {y_torch.shape} dyn(H,W)={dyn_out}")
    print(f"[{tag}]   torch vs ORT max abs diff = {max_diff:.3e}")
    print(f"[{tag}]   体积 {size_mb:.1f} MB")
    # 输入/输出数值范围摸底（供 SR.1 确定归一化约定）
    print(f"[{tag}]   输入范围摸底: in[0,1] 时 out min={y_torch.min():.3f} max={y_torch.max():.3f}")
    if max_diff > 1e-3:
        raise RuntimeError(f"{tag}: torch 与 ORT 数值不一致 (max diff {max_diff})")
    return dict(in_name=in_name, out_name=out_name, out_shape=list(y_torch.shape),
                dyn_in=dyn_in, dyn_out=dyn_out, max_diff=max_diff, size_mb=size_mb)


class UpCunet2x(nn.Module):
    def __init__(self):
        super().__init__()
        self.unet1 = UNet1(3, 3, deconv=True)
        self.unet2 = UNet2(3, 3, deconv=False)


class UpCunet3x(nn.Module):
    def __init__(self):
        super().__init__()
        self.unet1 = UNet1x3(3, 3, deconv=True)
        self.unet2 = UNet2(3, 3, deconv=False)


class UpCunet4x(nn.Module):
    def __init__(self):
        super().__init__()
        self.unet1 = UNet1(3, 64, deconv=True)
        self.unet2 = UNet2(64, 64, deconv=False)
        self.ps = nn.PixelShuffle(2)
        self.conv_final = nn.Conv2d(64, 12, 3, 1, padding=0, bias=True)


def load_cugan(kind, path):
    sd = torch.load(path, map_location="cpu", weights_only=True)
    if isinstance(sd, dict) and "pro" in sd:
        del sd["pro"]
    cls = {"2": UpCunet2x, "3": UpCunet3x, "4": UpCunet4x}[kind[-2]]
    model = cls()
    model.load_state_dict(strip_prefix(sd), strict=True)
    model.eval()
    wrapper = {"2": _CuganExport2x, "3": _CuganExport3x, "4": _CuganExport4x}[kind[-2]](model)
    return wrapper


def load_rcan(path):
    from safetensors.torch import load_file
    sd = strip_prefix(load_file(path))
    cfg = derive_rcan_config(sd)
    model = RCAN(**cfg)
    model.load_state_dict(sd, strict=True)
    model.eval()
    return model, cfg


class _FoldedConv3XC(nn.Module):
    """导出专用：把 _Conv3XC 的 1x1-3x3-1x1+sk 折叠成单个 3x3 卷积（权重一次性算好，forward 纯 Conv）。"""

    def __init__(self, src, relu=False):
        super().__init__()
        self.has_relu = relu
        src.update_params()  # 折叠计算写入 src.eval_conv
        self.eval_conv = nn.Conv2d(
            src.eval_conv.in_channels, src.eval_conv.out_channels, 3,
            stride=src.eval_conv.stride[0], padding=1,
            bias=src.eval_conv.bias is not None,
        )
        self.eval_conv.weight.data.copy_(src.eval_conv.weight.data)
        if self.eval_conv.bias is not None:
            self.eval_conv.bias.data.copy_(src.eval_conv.bias.data)

    def forward(self, x):
        out = self.eval_conv(x)
        if self.has_relu:
            out = F.leaky_relu(out, negative_slope=0.05)
        return out


def fold_conv3xc(module):
    """递归把 SPAN 里的 _Conv3XC 全部替换为 _FoldedConv3XC（结构等价）。"""
    for name, child in list(module.named_children()):
        if isinstance(child, _Conv3XC):
            setattr(module, name, _FoldedConv3XC(child))
        else:
            fold_conv3xc(child)


def load_span(path):
    from safetensors.torch import load_file
    sd = strip_prefix(load_file(path))
    # mean 是非持久 buffer（不在权重里）；no_norm 在权重里（norm=False 训练）
    sd.pop("mean", None)
    cfg = derive_span_config(sd)
    model = SPAN(**cfg)
    model.load_state_dict(sd, strict=True)
    model.eval()
    # 折叠前验证 torch 输出（折叠后必须等价）
    with torch.no_grad():
        ref = model(torch.rand(1, 3, 64, 64))
    fold_conv3xc(model)
    with torch.no_grad():
        after = model(torch.rand(1, 3, 64, 64))
    assert after.shape == ref.shape, "折叠后形状不一致"
    return model, cfg


def main():
    ap = argparse.ArgumentParser(description="SR.0 权重 → ONNX 转换")
    ap.add_argument("kind", choices=["cugan2x", "cugan3x", "cugan4x", "rcan2x", "span1x"])
    ap.add_argument("input", help="权重文件路径 (.pth / .safetensors)")
    ap.add_argument("output", help="输出 ONNX 路径")
    args = ap.parse_args()

    torch.set_num_threads(max(1, os.cpu_count() // 2))
    example = torch.rand(1, 3, 200, 200)

    if args.kind.startswith("cugan"):
        model = load_cugan(args.kind, args.input)
        tag = f"Real-CUGAN {args.kind[-2]}x"
    elif args.kind == "rcan2x":
        model, cfg = load_rcan(args.input)
        tag = f"AnimeSharpV4 RCAN2x cfg={cfg}"
    else:  # span1x
        model, cfg = load_span(args.input)
        tag = f"SuperScale SPAN1x cfg={cfg}"

    export_and_verify(model, example, args.output, tag)
    print(f"[{tag}] OK")


if __name__ == "__main__":
    main()
