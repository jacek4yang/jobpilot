import { asRecruiterId, type RecruiterId } from "../support/ids";

export interface Recruiter {
  readonly id: RecruiterId;
  readonly name: string;
  readonly title?: string;
  /** True when the listing is marked as an external headhunter (猎头). */
  readonly isHeadhunter?: boolean;
}

export const createRecruiter = (
  input: Omit<Recruiter, "id"> & { id?: RecruiterId },
): Recruiter => {
  const id = input.id ?? asRecruiterId(input.name.trim().toLowerCase());
  return {
    id,
    name: input.name.trim(),
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.isHeadhunter === undefined ? {} : { isHeadhunter: input.isHeadhunter }),
  };
};
