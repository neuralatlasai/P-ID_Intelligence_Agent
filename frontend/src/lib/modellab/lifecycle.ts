import type { StageId } from "./stages";

export interface ComputationBlock {
  readonly symbol: string;
  readonly title: string;
  readonly detail: string;
  readonly output: string;
}

interface LifecycleSpec {
  readonly purpose: string;
  readonly input: string;
  readonly output: string;
  readonly supervision: string;
  readonly equation: string;
  readonly equationNote: string;
  readonly blocks: readonly ComputationBlock[];
  readonly code: string;
  readonly gate: string;
}

/**
 * Design specifications, never execution traces. Shapes are symbolic because this UI has
 * no tokenizer, image processor, training worker or model weights attached. Keep that
 * boundary explicit instead of manufacturing token IDs, logits or accelerator timings.
 */
export const LIFECYCLE: Record<StageId, LifecycleSpec> = {
  pretraining: {
    purpose: "Align industrial evidence in a shared representation space.",
    input: "Linked image, drawing, topology and document records",
    output: "Domain adapters, projectors and alignment heads",
    supervision: "Paired evidence + masked targets + known graph relations",
    equation: "L = λmask Lmask + λalign Lalign + λocr Locr + λgraph Lgraph + λreg Lreg",
    equationNote:
      "Weighted multitask objective. The recipe below supplies the planned weights; unavailable modalities require masked loss terms.",
    blocks: [
      {
        symbol: "xₘ",
        title: "Modality encoders",
        detail:
          "Process each available modality with its own encoder and preserve source coordinates.",
        output: "hₘ ∈ ℝᴺᵐ×ᵈᵐ",
      },
      {
        symbol: "Pₘ",
        title: "Projection & packing",
        detail:
          "Project enabled modalities to the backbone width; retain modality and source masks.",
        output: "zₘ = Pₘ(hₘ)",
      },
      {
        symbol: "fθ",
        title: "Multimodal backbone",
        detail:
          "Fuse evidence tokens under the model-specific attention and position conventions.",
        output: "H ∈ ℝᴮ×ᴸ×ᵈ",
      },
      {
        symbol: "L",
        title: "Alignment objectives",
        detail:
          "Compare paired evidence, tags and graph relations; update the selected trainable modules.",
        output: "θ ← optimizer.step(∇θL)",
      },
    ],
    code: `# Training specification — not executed by this dashboard.
record = join_by_source_and_asset(evidence)
split = assign_group_split(record.drawing_id)  # before augmentation
batch = processor(record, enabled_modalities=config.modalities)
hidden = model(batch.inputs, attention_mask=batch.attention_mask)
loss = weighted_objectives(hidden, batch.targets, batch.modality_mask)
loss.backward()  # only modules selected in the applied recipe
optimizer.step()
optimizer.zero_grad()`,
    gate: "Evaluate retrieval, OCR grounding, graph relations and registration on held-out drawing groups before accepting the domain checkpoint.",
  },
  sft: {
    purpose: "Turn linked plant evidence into grounded instruction-following behavior.",
    input: "Instruction + evidence bundle + reviewed response",
    output: "Grounded SFT adapters or a full fine-tuned checkpoint",
    supervision: "Assistant response tokens; prompt and padding excluded",
    equation: "L_SFT = −Σₜ mₜ log pθ(yₜ | x, y<ₜ) / max(1, Σₜ mₜ)",
    equationNote:
      "mₜ is 1 only for supervised response tokens. The causal language-model implementation shifts logits and labels by one token.",
    blocks: [
      {
        symbol: "(x,y)",
        title: "Reviewed example",
        detail:
          "Pair the instruction and cited evidence with an approved target; keep source provenance.",
        output: "messages + evidence + target",
      },
      {
        symbol: "T",
        title: "Chat template",
        detail:
          "Use the backbone processor to insert role boundaries and image placeholders in the correct order.",
        output: "input_ids [B, L]",
      },
      {
        symbol: "mₜ",
        title: "Response loss mask",
        detail:
          "Ignore system, user, padding and non-text placeholder positions in the language-model loss.",
        output: "labels [B, L]; ignore = −100",
      },
      {
        symbol: "L",
        title: "Supervised update",
        detail:
          "Optimize response-token cross entropy with the configured grounding and topology auxiliary objectives.",
        output: "grounded instruction checkpoint",
      },
    ],
    code: `# Training specification — use the selected model's processor.
messages = [system_policy, user_instruction_with_evidence, reviewed_target]
batch = processor.apply_chat_template(messages, tokenize=True)
labels = batch.input_ids.clone()
labels[~batch.assistant_token_mask] = -100
labels[~batch.attention_mask] = -100
loss = model(**batch.model_inputs, labels=labels).loss
loss += grounding_auxiliary_loss(batch) + topology_auxiliary_loss(batch)
loss.backward()
optimizer.step()`,
    gate: "Gate on held-out answer grounding, citation validity, schema compliance and abstention behavior. Keep near-duplicate sheets out of both splits.",
  },
  rl: {
    purpose: "Improve the policy using independently checked engineering outcomes.",
    input: "Task + fixed evidence snapshot + candidate response group",
    output: "Verifier-aligned policy checkpoint and evaluation report",
    supervision: "Verifier rewards; frozen reference-policy constraint",
    equation: "Aᵢ = (rᵢ − mean(r)) / (std(r) + ε)",
    equationNote:
      "Illustrative GRPO advantage, normalized within one prompt group. A clipped policy-ratio objective and a separate KL penalty constrain the update; this UI does not execute GRPO or PPO.",
    blocks: [
      {
        symbol: "πold",
        title: "Collect rollouts",
        detail:
          "Sample G candidate responses per task from a fixed policy version and evidence snapshot.",
        output: "{y₁, …, yG}, log pold",
      },
      {
        symbol: "V",
        title: "Verify & score",
        detail:
          "Check identity, topology, citations and supported values against independent records.",
        output: "rᵢ = Σⱼ wⱼ vⱼ(yᵢ)",
      },
      {
        symbol: "Aᵢ",
        title: "Group advantages",
        detail:
          "Normalize per prompt. Equal-reward groups have zero learning signal; keep a numerical epsilon.",
        output: "response advantages [B, G]",
      },
      {
        symbol: "πθ",
        title: "Constrained update",
        detail:
          "Clip the new/old likelihood ratio and constrain divergence from a frozen reference policy.",
        output: "updated policy + KL report",
      },
    ],
    code: `# GRPO-style specification; simulated rollouts are displayed below.
evidence = freeze_evidence_snapshot(task)
responses, old_logp = policy_old.sample(task, evidence, count=G)
rewards = verifier(responses, evidence)  # independent checks
advantages = (rewards - rewards.mean()) / (rewards.std() + norm_eps)
ratio = exp(policy.logp(responses) - old_logp.detach())
surrogate = minimum(ratio * advantages, clip(ratio, 1-clip_eps, 1+clip_eps) * advantages)
loss = -masked_mean(surrogate) + beta * kl_to_frozen_reference()
loss.backward()
optimizer.step()`,
    gate: "Inspect reward components alongside held-out verifier pass rate, unsupported claims and KL drift. Reward improvement alone is insufficient for promotion.",
  },
  distillation: {
    purpose:
      "Transfer verified behavior into a smaller model with a measurable serving budget.",
    input: "Shared evidence + verified teacher targets + student outputs",
    output: "Student checkpoint, processor assets and serving manifest",
    supervision: "Teacher targets; soft distributions only when logits are available",
    equation: "L_KD = α T² KL(pteacherᵀ ∥ pstudentᵀ) + (1 − α) L_CE",
    equationNote:
      "T is temperature. Logit distillation requires compatible vocabularies or an explicit mapping; text-only teacher access supports sequence distillation instead. Feature transfer additionally needs shape-alignment adapters.",
    blocks: [
      {
        symbol: "fT",
        title: "Frozen teacher",
        detail:
          "Generate verified target responses; retain logits or hidden states only when the teacher exposes them.",
        output: "target tokens / optional logits",
      },
      {
        symbol: "fS",
        title: "Student forward",
        detail:
          "Process the same evidence with the student's own processor and enabled compact encoders.",
        output: "student logits [B, L, V]",
      },
      {
        symbol: "LKD",
        title: "Transfer objective",
        detail:
          "Match teacher distributions when compatible; otherwise supervise on verified teacher sequences.",
        output: "student gradients only",
      },
      {
        symbol: "E",
        title: "Export & qualify",
        detail:
          "Evaluate fidelity, grounding, latency and memory before quantization and engine-specific packaging.",
        output: "candidate serving bundle",
      },
    ],
    code: `# Distillation specification — teacher remains frozen.
with no_grad():
    target = teacher(shared_evidence)
student_output = student(student_processor(shared_evidence))
if compatible_logits_available(target, student_output):
    loss = alpha * T**2 * kl(target.logits / T, student_output.logits / T)
    loss += (1 - alpha) * response_cross_entropy(student_output, target)
else:
    loss = verified_sequence_cross_entropy(student_output, target.text)
loss.backward()  # student parameters only
optimizer.step()`,
    gate: "Compare teacher/student grounding on the same holdout. Benchmark TTFT, inter-token latency, end-to-end p95 and peak memory at a stated concurrency before deployment.",
  },
};
